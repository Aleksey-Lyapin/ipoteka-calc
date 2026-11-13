/* Общие правила и расчёт ипотечных калькуляторов BAZA (window.IpotekaCore).
   Источник — этот файл в папке ipoteka-calculator. Он встраивается в ipoteka-calc (index.html, programmy.html)
   и выкладывается как https://aleksey-lyapin.github.io/ipoteka-calc/calc-core.js — ipoteka-calc-ekb-msk и сайты calc_…
   загружают его оттуда при открытии (встроенная копия — запасная). Любая правка здесь меняет расчёт на всех этих сайтах:
   менять только с сохранением API (имена функций и полей ниже). */
(function () {
  'use strict';

  /* ================== ПРАВИЛА ================== */
  var RULES = {
    // Своя скидка на квартиру у программы, по проектам (вместо скидки из поля): часть названия + льготная ставка (null — любая).
    // Проекта нет в disc — обычная скидка
    programDiscounts: [{
      name: 'ипотека для всех на срок строительства (Совком)', r1: 0.044,
      disc: { 'ДМД 1 оч.': 0.05, 'ДМД 2 оч.': 0.05, 'ДНК 1 оч.': 0.05, 'ДНК 2 оч.': 0.05, 'Алиса 1 оч.': 0.05 }   // 0 — без скидки (базовая цена)
    }, {
      // exact — название целиком (без «Субсид. семейная ипотека на весь срок (Сбер)»), любое количество детей
      name: 'Семейная ипотека (Сбер)', exact: true,
      disc: { 'ДМД 2 оч.': 0.12, 'Бестселлер': 0.04 }
    }],
    // Макс. скидка на квартиру для программ с субсидией застройщика, по проектам: введена скидка больше — в расчёт идёт эта
    subsidyDiscountCap: { 'ДНК 2 оч.': 0.15 },
    // Траншевая ипотека (листы без своих дат): второй транш — через secondMonths мес. после ДДУ (ДДУ — сегодня),
    // третий — thirdDate (у проектов из thirdDateByProject — своя дата); первый транш с долей не больше firstMinShare — не меньше firstMin ₽
    tranche: { secondMonths: 12, thirdDate: '2028-11-30', thirdDateByProject: { 'ДНК 2 оч.': '2029-11-30' }, firstMinShare: 0.01, firstMin: 100000 },
    // Комбо-ипотека: средневзвешенная ставка на весь срок, но через years лет растёт на add (часть названия программы).
    // Первые years лет платёж как раньше (семейная и базовая части), затем остаток долга — аннуитет по (средневзвешенная + add)
    comboStepUp: [{ name: '(ВТБ)', years: 15, add: 0.04 }],
    // Типы ипотеки, где все подходящие программы показываются сразу (без «Показать все программы»)
    showAllTypes: ['IT ипотека', 'Семейная ипотека', 'Комбо-ипотека', 'Траншевая ипотека']
  };

  var FAMILY = 'Семейная ипотека', COMBO = 'Комбо-ипотека', TRANCHE = 'Траншевая ипотека', OK = 'Применяется';
  // Типы, где условия зависят от количества детей
  function byKids(type) { return type === FAMILY || type === COMBO; }
  var KIDS_ORDER = ['один ребёнок', 'двое детей', 'трое детей', 'четверо детей', 'пятеро и больше'];

  /* ================== РАЗБОР ЛИСТОВ ================== */
  // Число из ячейки: число как есть; текст «15», «20,1%», «300 000» — разбирается; «–», «-», пусто — null
  function numx(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    var s = v.replace(/[\s  ]/g, '').replace(',', '.'), isPct = s.indexOf('%') >= 0;
    s = s.replace('%', '');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    return isPct ? parseFloat(s) / 100 : parseFloat(s);
  }
  // Латинские буквы, похожие на русские, внутри русских слов («Cемейная» с латинской C) — заменяем на русские,
  // иначе сортировка по алфавиту ставит такие программы не на своё место
  var HOMO = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у' };
  function fixHomoglyphs(s) {
    return s.replace(/[ABCEHKMOPTXaceopxy]/g, function (ch, i) {
      var prev = s.charAt(i - 1), next = s.charAt(i + 1);
      return /[а-яё]/i.test(prev) || /[а-яё]/i.test(next) ? HOMO[ch] : ch;
    });
  }
  function projectsOf(v) { return String(v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean); }
  function nameOf(v) { return fixHomoglyphs(String(v).trim().replace(/\s{2,}/g, ' ')); }
  function kidsOf(v) { var k = v == null ? '' : String(v).trim(); return /^[-–—]?$/.test(k) ? null : k; }
  function rowOk(r) { return r && r[1] && r[2]; }

  /* Лист «Программы» (и «Программы_Мск»), колонки A–O:
     A проекты (через запятую) · B тип · C программа · D ставка льготная · E ставка основная · F льготный период, лет ·
     G мин. срок · H макс. срок · I мин. ПВ · J макс. ПВ · K мин. кредит · L лимит кредита · M субсидия · N ограничения · O дети */
  function parsePrograms(rows) {
    return (rows || []).filter(rowOk).map(function (r) {
      var r1 = numx(r[3]) || 0, r2 = numx(r[4]);
      return {
        projects: projectsOf(r[0]), type: String(r[1]).trim(), name: nameOf(r[2]),
        r1: r1, r2: r2 == null ? r1 : r2, grace: numx(r[5]) || 0,
        minTerm: numx(r[6]) || 0, term: numx(r[7]) || 30,
        mpv: numx(r[8]) || 0, maxPv: numx(r[9]) == null ? 1 : numx(r[9]),
        minLoan: numx(r[10]) || 0, lim: numx(r[11]) == null ? Infinity : numx(r[11]),
        sub: numx(r[12]) || 0, restr: numx(r[13]), kids: kidsOf(r[14])
      };
    });
  }
  /* Листы «Комбо_…», колонки A–P: A проекты · B тип · C программа · D ставка (семейная) · E ставка (базовая) ·
     F льготный период · G мин. срок · H макс. срок · I мин. ПВ · J макс. ПВ · K макс. семейная часть кредита ·
     L мин. кредит (суммарно) · M лимит кредита (суммарно) · N субсидия (% от превышения над семейной частью) · O ограничения · P дети */
  function parseCombo(rows) {
    return (rows || []).filter(function (r) { return rowOk(r) && numx(r[3]) != null; }).map(function (r) {
      var r1 = numx(r[3]) || 0, r2 = numx(r[4]);
      return {
        projects: projectsOf(r[0]), type: String(r[1]).trim(), name: nameOf(r[2]),
        combo: true, r1: r1, r2: r2 == null ? r1 : r2, grace: 0,
        minTerm: numx(r[6]) || 0, term: numx(r[7]) || 30,
        mpv: numx(r[8]) || 0, maxPv: numx(r[9]) == null ? 1 : numx(r[9]),
        famLim: numx(r[10]) == null ? Infinity : numx(r[10]),
        minLoan: numx(r[11]) || 0, lim: numx(r[12]) == null ? Infinity : numx(r[12]),
        sub: numx(r[13]) || 0, restr: numx(r[14]), kids: kidsOf(r[15])
      };
    });
  }
  /* Листы траншевой ипотеки: A проекты · B тип · C программа · D ставка льготная · E ставка основная ·
     далее n столбцов с долями траншей от цены, затем: скидка программы · льготный период · мин. срок · макс. срок ·
     мин. ПВ · макс. ПВ · мин. кредит · лимит кредита · субсидия · ограничения · дети («Траншевая_Сбер»: n = 3, A–S).
     ts: { n, dates?, firstAmount? } — dates: 0 — сегодня (ДДУ), '+12' — через 12 мес., 'ГГГГ-ММ-ДД'; нет dates — RULES.tranche */
  function parseTranche(rows, ts) {
    var n = ts.n, c = 5 + n;
    return (rows || []).filter(function (r) { return rowOk(r) && numx(r[3]) != null; }).map(function (r) {
      var r1 = numx(r[3]) || 0, r2 = numx(r[4]);
      return {
        projects: projectsOf(r[0]), type: String(r[1]).trim(), name: nameOf(r[2]),
        tranche: r.slice(5, c).map(function (v) { return numx(v) || 0; }), tdates: ts.dates, tfirst: ts.firstAmount,
        disc: numx(r[c]) || 0, // скидка задана в программе — поле «Скидка на квартиру» не используется
        r1: r1, r2: r2 == null ? r1 : r2, grace: numx(r[c + 1]) || 0,
        minTerm: numx(r[c + 2]) || 0, term: numx(r[c + 3]) || 30,
        mpv: numx(r[c + 4]) || 0, maxPv: numx(r[c + 5]) == null ? 1 : numx(r[c + 5]),
        minLoan: numx(r[c + 6]) || 0, lim: numx(r[c + 7]) == null ? Infinity : numx(r[c + 7]),
        sub: numx(r[c + 8]) || 0, restr: numx(r[c + 9]), kids: kidsOf(r[c + 10])
      };
    });
  }
  // Данные для compute: проекты (из «Справочников», только с программами), типы, количества детей, допуск и порог скидки
  function finishData(programs, raw) {
    var withPrograms = {};
    programs.forEach(function (p) { p.projects.forEach(function (x) { withPrograms[x] = true; }); });
    var projects = (raw.projects || []).map(function (p) { return String(p).trim(); }).filter(function (p) { return withPrograms[p]; });
    Object.keys(withPrograms).forEach(function (x) { if (projects.indexOf(x) < 0) projects.push(x); });
    var kidsList = [];
    programs.forEach(function (p) { if (byKids(p.type) && p.kids && kidsList.indexOf(p.kids) < 0) kidsList.push(p.kids); });
    kidsList.sort(function (a, b) {
      var ia = KIDS_ORDER.indexOf(a), ib = KIDS_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    var types = (raw.types && raw.types.length ? raw.types : ['Семейная ипотека', 'IT ипотека', 'Ипотека для всех']).map(String);
    // Типов с листов комбо и траншевой в «Справочниках» нет — добавляем в конец списка
    programs.forEach(function (p) { if (types.indexOf(p.type) < 0) types.push(p.type); });
    return {
      programs: programs, projects: projects, types: types, kidsList: kidsList.length ? kidsList : KIDS_ORDER.slice(),
      tolerance: typeof raw.tolerance === 'number' ? raw.tolerance : 0.002,
      threshold: typeof raw.threshold === 'number' ? raw.threshold : 0.01
    };
  }

  /* ================== РАСЧЁТ (повторяет формулы листа «Калькулятор») ================== */
  function p15(x) { return +x.toPrecision(15); }
  function round0(x) { return x < 0 ? -Math.round(p15(-x)) : Math.round(p15(x)); }
  function round6(x) { return round0(x * 1e6) / 1e6; }
  function roundup0(x) { return x < 0 ? -Math.ceil(p15(-x)) : Math.ceil(p15(x)); }
  function PMT(r, n, loan) { return r === 0 ? loan / n : loan * r / (1 - Math.pow(1 + r, -n)); }
  function balance(r, n, pay, loan) { // = FV(r; n; pay; -loan)
    if (r === 0) return loan - pay * n;
    var f = Math.pow(1 + r, n);
    return loan * f - pay * (f - 1) / r;
  }
  var nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  var nfp1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  function rub(v) { return nf0.format(Math.round(v)) + ' ₽'; }
  function pct1(v) { return nfp1.format(v * 100) + '%'; }

  /* Траншевая ипотека: кредит выдаётся частями. Суммы — доли цены из листа; последний транш — остаток кредита
     (при ПВ больше минимального уменьшается он). Даты — из листа (p.tdates) или RULES.tranche: первый — сегодня (ДДУ),
     второй — через secondMonths мес., третий — дата проекта. Платёж — аннуитет на выданную сумму до конца срока,
     после каждого транша пересчитывается на остаток месяцев. */
  function addMonths(d, n) {
    var r = new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
    if (r.getDate() !== d.getDate()) r.setDate(0); // 31-е → последний день месяца
    return r;
  }
  function monthsBetween(a, b) {
    var m = (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth();
    return b.getDate() < a.getDate() ? m - 1 : m;
  }
  function trancheDate(spec, today) {
    if (!spec) return today;
    if (typeof spec === 'string' && spec.charAt(0) === '+') return addMonths(today, parseInt(spec.slice(1), 10));
    var d = new Date(spec + 'T00:00:00');
    return isNaN(d) || d < today ? today : d;
  }
  function trancheDates(p, project) {
    if (p.tdates) return p.tdates;
    var T = RULES.tranche;
    return [0, '+' + T.secondMonths, (T.thirdDateByProject || {})[project] || T.thirdDate];
  }
  function trancheSchedule(p, price, loan, X, gm, r1, r2, project) {
    var T = RULES.tranche, sh = p.tranche, n = sh.length, dates = trancheDates(p, project);
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var amts = [], left = loan;
    for (var i = 0; i < n; i++) {
      var a;
      if (i === n - 1) a = left; // последний транш — остаток кредита
      else {
        a = round0(price * sh[i]);
        // 1%, но не меньше 100 000 ₽; если у листа задан firstAmount — ровно эта сумма (Бестселлер)
        if (i === 0 && sh[0] <= T.firstMinShare + 1e-9) a = p.tfirst != null ? p.tfirst : Math.max(a, T.firstMin);
        a = Math.min(a, left);
      }
      amts.push(a); left -= a;
    }
    var list = amts.map(function (a, i) {
      var d = trancheDate(dates[i], today);
      return { no: i + 1, d: d, amt: a, m: Math.min(Math.max(monthsBetween(today, d), 0), X - 1) };
    }).sort(function (x, y) { return x.m - y.m || x.no - y.no; });
    var bal = 0, pay = 0, tot = 0, j = 0;
    for (var k = 0; k < X; k++) { // k — сколько месяцев прошло с выдачи первого транша
      var added = [];
      while (j < list.length && list[j].m <= k) { bal += list[j].amt; added.push(list[j]); j++; }
      var r = (k < gm ? r1 : r2) / 12;
      if (added.length || k === gm) {
        pay = bal > 0 ? PMT(r, X - k, bal) : 0;
        added.forEach(function (t) { t.pay = pay; });
      }
      bal = bal * (1 + r) - pay;
      tot += pay;
    }
    return { list: list, tot: tot };
  }

  // Банк в названии программы — в скобках в конце: «Субсид. семейная ипотека на весь срок (ВТБ)»
  var BANK_RE = /\s*\(([^()]+)\)\s*$/;
  function bankOf(name) { var m = BANK_RE.exec(name); return m ? m[1].trim() : ''; }
  function progOf(name) { var m = BANK_RE.exec(name); return m ? name.slice(0, m.index).trim() : name; }

  // Своя скидка программы в проекте (RULES.programDiscounts, затем дополнительные правила страницы extra):
  // совпадает часть названия (exact — всё название) и льготная ставка; нет правила — null
  function progDiscount(p, project, extra) {
    var rules = RULES.programDiscounts.concat(extra || []);
    for (var i = 0; i < rules.length; i++) {
      var m = rules[i], pn = p.name.toLowerCase(), mn = m.name.toLowerCase();
      if ((m.exact ? pn === mn : pn.indexOf(mn) >= 0) && (m.r1 == null || Math.abs(p.r1 - m.r1) < 1e-9) && m.disc[project] != null)
        return m.disc[project];
    }
    return null;
  }

  // Правило повышения ставки комбо-ипотеки (RULES.comboStepUp) для программы или null
  function comboStepUp(p) {
    var list = RULES.comboStepUp || [];
    for (var i = 0; i < list.length; i++) if (p.name.indexOf(list[i].name) >= 0) return list[i];
    return null;
  }
  /* Расчёт всех программ проекта и типа. inp: { project, type, kids, base, finish, disc, coupon, pv, term, prog, flt }.
     opt (настройки страницы): { subsidyNoDiscountProjects: [...] — проекты, где у программ с субсидией скидки нет (Бестселлер),
     programDiscounts: [...] — дополнительные правила своей скидки программы } */
  function compute(D, inp, opt) {
    opt = opt || {};
    var noDiscProjects = opt.subsidyNoDiscountProjects || [];
    var fam = byKids(inp.type);
    var base = inp.base, BT = inp.base + inp.finish;
    var pvIn = inp.pv || 0;
    // Программы проекта и типа; для семейной и комбо — ещё и по количеству детей
    var list = D.programs.filter(function (p) {
      return p.projects.indexOf(inp.project) >= 0 && p.type === inp.type && (!fam || p.kids === inp.kids);
    });

    var rows = list.map(function (p, i) {
      var r1 = p.r1;
      // Комбо: r1 — ставка семейной части, r2 — базовой части, льготного периода нет
      var r2 = p.combo || p.grace !== 0 ? p.r2 : r1;
      // Льготный период учитываем, только если ставка после него другая («на весь срок» — одна ставка)
      var gn = p.combo || Math.abs(r2 - r1) < 1e-12 ? 0 : round0(p.grace * 12);
      // Срок: введённый клиентом, но в рамках мин./макс. срока программы (G, H); пусто — максимальный
      var maxTerm = p.term, minTerm = Math.min(p.minTerm, maxTerm);
      var term = inp.term != null ? Math.min(Math.max(inp.term, 1, minTerm), maxTerm) : maxTerm;
      var mpv = p.mpv;
      var lim = p.lim;
      var sub = p.sub;
      // Комбо: субсидия — % не от всего кредита, а от превышения над семейной частью (кредит − семейная часть)
      var subBase = function (L) { return p.combo ? Math.max(L - p.famLim, 0) : L; };
      // шаг 1 — субсидия по базовой цене
      var pv0 = Math.min(Math.max(pvIn, roundup0(BT * mpv), BT - lim), BT);
      var sub0 = subBase(BT - pv0) * sub;
      var subp = base > 0 ? sub0 / base : 0;
      // шаг 2 — итоговая цена с порогом скидки
      // программы из programDiscounts — своя скидка проекта; траншевая — скидка из листа; остальные — из поля (скидка проекта)
      var pdOwn = progDiscount(p, inp.project, opt.programDiscounts);
      var pdisc = pdOwn != null ? pdOwn : p.disc != null ? p.disc : inp.disc;
      // программы с субсидией в проектах из RULES.subsidyDiscountCap — скидка не больше макс. (ДНК 2 оч.: 15%)
      var cap = sub > 0 && pdOwn == null && p.disc == null ? (RULES.subsidyDiscountCap || {})[inp.project] : null;
      var capped = cap != null && pdisc > cap + 1e-12;
      if (capped) pdisc = cap;
      // Субсидированная программа в проектах subsidyNoDiscountProjects (Бестселлер) — без скидки на квартиру
      var noDisc = noDiscProjects.indexOf(inp.project) >= 0 && sub > 0;
      var discIn = noDisc ? 0 : pdisc;
      var praw = Math.min(round0(base * (1 - discIn) + sub0 + inp.finish), BT);
      var price0 = round6(1 - praw / BT) < D.threshold ? BT : praw;
      var disc = BT > 0 ? 1 - price0 / BT : 0; // скидка без купона
      // Агентская скидка (купон, ₽) — вычитается в самом конце из итоговой цены
      var coupon = Math.min(inp.coupon || 0, price0);
      var price = price0 - coupon;
      var mpvr = Math.max(roundup0(price * mpv), price - lim);
      var pv = Math.min(Math.max(pvIn, mpvr), price);
      var loan = price - pv;
      var subr = subBase(loan) * sub;
      var pvShare = price > 0 ? pv / price : 0;
      var status = loan <= 0 ? 'Кредит не нужен'
        : (p.restr != null && base < p.restr) ? 'Не подходит для квартиры'
        : pvShare > p.maxPv + 1e-12 ? 'ПВ больше максимального'          // J — макс. ПВ
        : loan < p.minLoan ? 'Кредит меньше минимального'                 // K — мин. размер кредита
        : sub === 0 ? OK
        // Без скидки (Бестселлер): показываем, только если субсидия в ₽ (кредит × M) не больше скидки в ₽ (база × скидка)
        : noDisc ? (subr <= base * pdisc + 0.5 ? OK : 'Не применяется')
        : subp <= pdisc + D.tolerance + 1e-12 ? OK : 'Не применяется';
      var X = term * 12;
      var gm = Math.min(gn, X);
      // Комбо: семейная часть — до лимита K по семейной ставке, остаток — по базовой; срок у частей общий
      var famLoan = p.combo ? Math.min(Math.max(loan, 0), p.famLim) : 0;
      var baseLoan = p.combo ? Math.max(loan - famLoan, 0) : 0;
      var pf = p.combo && famLoan > 0 && X > 0 ? PMT(r1 / 12, X, famLoan) : 0;
      var pb = p.combo && baseLoan > 0 && X > 0 ? PMT(r2 / 12, X, baseLoan) : 0;
      var p1 = p.combo ? pf + pb : loan <= 0 || X <= 0 ? 0 : PMT(r1 / 12, X, loan);
      var bal = gm === 0 || loan <= 0 ? 0 : balance(r1 / 12, gm, p1, loan);
      var p2 = gm === 0 ? p1 : (X - gm <= 0 ? 0 : PMT(r2 / 12, X - gm, bal));
      var tot = gm === 0 ? p1 * X : p1 * gm + p2 * (X - gm);
      // средневзвешенная ставка комбо — по суммам семейной и базовой частей
      var wr = famLoan + baseLoan > 0 ? (famLoan * r1 + baseLoan * r2) / (famLoan + baseLoan) : r1, wr2 = null;
      // Комбо с повышением ставки (RULES.comboStepUp, ВТБ): после stepUp.years лет — остаток обеих частей по ставке wr + add
      var su = p.combo ? comboStepUp(p) : null;
      if (su && loan > 0 && X > round0(su.years * 12)) {
        gm = round0(su.years * 12);
        bal = balance(r1 / 12, gm, pf, famLoan) + balance(r2 / 12, gm, pb, baseLoan);
        wr2 = wr + su.add;
        p2 = PMT(wr2 / 12, X - gm, bal);
        tot = p1 * gm + p2 * (X - gm);
      }
      var tr = p.tranche && loan > 0 && X > 0 ? trancheSchedule(p, price, loan, X, gm, r1, r2, inp.project) : null;
      if (tr) { // траншевая: p1 — платёж после первого транша, p2 — после выдачи всего кредита
        var paid = tr.list.filter(function (t) { return t.amt > 0; });
        p1 = paid[0].pay; p2 = paid[paid.length - 1].pay; tot = tr.tot;
      }
      var over = Math.max(tot - loan, 0);
      var note = status === 'Не применяется' ? 'Субсидия больше скидки'
        : status === 'ПВ больше максимального' ? 'Программа для ПВ до ' + pct1(p.maxPv) + ', в расчёте ' + pct1(pvShare)
        : status === 'Кредит меньше минимального' ? 'Программа для кредита от ' + rub(p.minLoan)
        : pv > pvIn + 0.5 ? (pvIn === 0 ? 'Взят минимальный ПВ' : 'ПВ увеличен до минимума')
        : (inp.term != null && inp.term > term) ? 'Срок снижен до максимального'
        : (inp.term != null && inp.term < term) ? 'Срок увеличен до минимального' : '';
      if (noDisc && inp.disc > 0 && status === OK) note = 'Скидка на квартиру по этой программе не действует' + (note ? '. ' + note : '');
      else if (pdOwn != null && Math.abs(pdOwn - inp.disc) > 1e-9 && status === OK)
        note = (pdOwn ? 'Скидка на квартиру по этой программе — ' + pct1(pdOwn) : 'Скидка на квартиру по этой программе не действует') + (note ? '. ' + note : '');
      if (capped && status === OK) note = 'По программе с субсидией скидка на квартиру — не больше ' + pct1(cap) + (note ? '. ' + note : '');
      return {
        n: i + 1, name: fam ? p.name + ' — ' + inp.kids : p.name,
        // Для таблицы: банк — из скобок в конце названия «… (Абсолют)», название — без скобок (банк не указан — «—»)
        bank: bankOf(p.name), title: fam ? progOf(p.name) + ' — ' + inp.kids : progOf(p.name), r1: r1, r2: r2, gm: gm, term: term, mpv: mpv, lim: lim, maxPv: p.maxPv,
        sub: sub, subp: subp, status: status, price: price, disc: disc, coupon: coupon, mpvr: mpvr, pv: pv, loan: loan, subr: subr,
        p1: p1, p2: p2, bal: bal, tot: tot, over: over, note: note, pvUp: pvIn > 0 && pv > pvIn + 0.5,
        combo: !!p.combo, famLoan: famLoan, baseLoan: baseLoan, pf: pf, pb: pb,
        tranches: tr ? tr.list.filter(function (t) { return t.amt > 0; }) : null,
        // wr — средневзвешенная ставка комбо; wr2 — она же после повышения (comboStepUp; иначе null), действует с месяца gm + 1
        wr: wr, wr2: wr2,
        pdisc: discIn // скидка, с которой посчитана программа (своя / из листа / из поля с учётом ограничения)
      };
    });

    // Основной список: ПВ не больше чем на 10% выше указанного (или минимального, если ПВ не указан)
    var shareOf = function (r) { return r.price > 0 ? r.pv / r.price : 1; };
    var minShareAll = Infinity;
    rows.forEach(function (r) { if (r.status === OK && shareOf(r) < minShareAll) minShareAll = shareOf(r); });
    // Дальше 20% — программа убирается совсем (кроме типов из RULES.showAllTypes)
    var showAllType = RULES.showAllTypes.indexOf(inp.type) >= 0;
    rows.forEach(function (r) {
      r.inMain = pvIn > 0 ? r.pv <= pvIn * 1.1 + 0.5 : shareOf(r) <= minShareAll * 1.1 + 1e-9;
      r.excluded = !showAllType && (pvIn > 0 ? r.pv > pvIn * 1.2 + 0.5 : shareOf(r) > minShareAll * 1.2 + 1e-9);
    });
    var fits = function (r) { return r.status === OK && !r.excluded; };
    // Фильтры над перечнем (банк, ставка, цена, ПВ, платёж): автоподбор и список — только среди подходящих под них
    var usable = function (r) { return fits(r) && (!inp.flt || inp.flt(r)); };

    // выбор программы для подробного расчёта; выбранная вручную, но ставшая неподходящей — сбрасывается на автоподбор
    var sel = 0, progReset = false;
    var prog = inp.prog;
    if (prog != null && (!rows[prog - 1] || !usable(rows[prog - 1]))) { prog = null; progReset = true; }
    if (prog != null) {
      sel = prog;
    } else {
      var best = function (pred) {
        var b = 0, m = Infinity;
        rows.forEach(function (r) { if (pred(r) && r.p1 < m) { m = r.p1; b = r.n; } });
        return b;
      };
      // ПВ указан — сначала программы без доплаты к нему. ПВ пустой — сравниваем платежи только среди программ
      // с наименьшим ПВ (иначе выигрывают программы, где ПВ поднят до 50% и платёж ниже за счёт взноса)
      var share = function (r) { return r.price > 0 ? r.pv / r.price : 1; };
      var minShare = Infinity;
      rows.forEach(function (r) { if (usable(r) && share(r) < minShare) minShare = share(r); });
      sel = (pvIn > 0 ? best(function (r) { return usable(r) && r.pv <= pvIn + 0.5; })
                      : best(function (r) { return usable(r) && share(r) <= minShare + 0.005; })) ||
            best(usable) || 0;
    }
    var alerts = [];
    if (!rows.some(usable))
      alerts.push(rows.some(fits) ? 'По выбранным фильтрам программ нет — измените или сбросьте фильтры'
        : 'При выбранных условиях нет подходящих программ — измените ПВ, срок, скидку или тип ипотеки');
    return { rows: rows, sel: sel, alerts: alerts, progReset: progReset, fits: fits, usable: usable };
  }

  window.IpotekaCore = {
    version: '2026-11-13',
    RULES: RULES, FAMILY: FAMILY, COMBO: COMBO, TRANCHE: TRANCHE, OK: OK, KIDS_ORDER: KIDS_ORDER, byKids: byKids,
    numx: numx, fixHomoglyphs: fixHomoglyphs, parsePrograms: parsePrograms, parseCombo: parseCombo, parseTranche: parseTranche, finishData: finishData,
    p15: p15, round0: round0, round6: round6, roundup0: roundup0, PMT: PMT, balance: balance,
    addMonths: addMonths, monthsBetween: monthsBetween, trancheDate: trancheDate, trancheDates: trancheDates, trancheSchedule: trancheSchedule,
    bankOf: bankOf, progOf: progOf, progDiscount: progDiscount, comboStepUp: comboStepUp, compute: compute
  };
})();
