/* 지름길 점검기 — 모든 계산은 브라우저 안에서 합니다. */
(function () {
  "use strict";

  // ---------------------------------------------------------------- 설정
  var MAX_BYTES = 100 * 1024 * 1024;   // 100MB
  var MAX_ROWS = 200000;               // 이보다 많으면 고정 시드로 표본 추출
  var MIN_ROWS = 20;
  var TRAIN_RATIO = 0.7;
  var SEED = 42;
  var SHOW_TOP = 10;
  // 판정 기준(앱이 정한 값. 논문은 별도 기준을 정하지 않았음)
  var LEVEL = { dangerBacc: 0.99, warnBacc: 0.85, metaDanger: 0.9, metaWarn: 0.7 };

  var S = null; // 현재 데이터 상태

  // ---------------------------------------------------------------- 도우미
  function $(id) { return document.getElementById(id); }
  function show(el, on) { el.classList.toggle("hidden", !on); }
  function pct(x) { return (x * 100).toFixed(2) + "%"; }
  function pp(x) { return (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%p"; }
  function fmt(v) {
    if (!isFinite(v)) return String(v);
    var a = Math.abs(v);
    if (a !== 0 && (a < 0.001 || a >= 1e7)) return v.toExponential(3);
    return String(Math.round(v * 1000) / 1000);
  }
  function setMsg(el, text, kind) {
    el.textContent = text || "";
    el.className = "msg" + (kind ? " " + kind : "");
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffledIndex(n, seed) {
    var idx = new Array(n), r = mulberry32(seed), i, j, t;
    for (i = 0; i < n; i++) idx[i] = i;
    for (i = n - 1; i > 0; i--) { j = Math.floor(r() * (i + 1)); t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
    return idx;
  }
  // 빈칸을 뺀 값이 한 가지 이하인 열 — 라벨에 대해 알려 주는 정보가 없다
  function isSingle(c) { return c.distinct.length <= 1; }
  function nameList(names, max) {
    max = max || 6;
    return names.slice(0, max).join(", ") + (names.length > max ? " 외 " + (names.length - max) + "개" : "");
  }

  function toNum(s) {
    if (s === undefined || s === null) return NaN;
    s = String(s).trim();
    if (s === "" || /^(nan|na|null|none|-|\?)$/i.test(s)) return NaN;
    var v = Number(s);
    return isFinite(v) ? v : NaN;
  }

  // ---------------------------------------------------------------- CSV 읽기
  function detectDelimiter(firstLine) {
    var best = ",", bestN = 0;
    [",", "\t", ";"].forEach(function (d) {
      var n = firstLine.split(d).length - 1;
      if (n > bestN) { best = d; bestN = n; }
    });
    return best;
  }
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var firstLine = text.slice(0, Math.min(text.length, 10000)).split(/\r?\n/)[0] || "";
    var d = detectDelimiter(firstLine);
    var rows = [], row = [], field = "", inQ = false, i, c, n = text.length;
    for (i = 0; i < n; i++) {
      c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
        } else field += c;
      } else if (c === '"' && field === "") inQ = true;
      else if (c === d) { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (!(row.length === 1 && row[0] === "")) rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); if (!(row.length === 1 && row[0] === "")) rows.push(row); }
    return rows;
  }

  function loadText(text, name) {
    var rows = parseCSV(text);
    if (rows.length < 2) throw new Error("표로 읽을 수 있는 줄이 없습니다. 첫 줄이 열 이름인 CSV 파일인지 확인해 주세요.");
    var header = rows[0].map(function (h, i) { h = String(h).trim(); return h || ("열" + (i + 1)); });
    if (header.length < 2) throw new Error("열이 하나뿐입니다. 쉼표(,)·탭·세미콜론으로 나뉜 CSV인지 확인해 주세요.");
    var seen = {};
    header = header.map(function (h) { var k = h, j = 2; while (seen[k]) k = h + " (" + (j++) + ")"; seen[k] = 1; return k; });
    var body = [], skipped = 0;
    for (var i = 1; i < rows.length; i++) {
      if (rows[i].length === header.length) body.push(rows[i]); else skipped++;
    }
    if (body.length < MIN_ROWS) throw new Error("열 개수가 맞는 데이터 행이 " + body.length + "개뿐입니다. 최소 " + MIN_ROWS + "행이 필요합니다.");
    var sampled = false, total = body.length;
    if (body.length > MAX_ROWS) {
      var idx = shuffledIndex(body.length, SEED).slice(0, MAX_ROWS).sort(function (a, b) { return a - b; });
      body = idx.map(function (k) { return body[k]; });
      sampled = true;
    }
    // 열 유형
    var cols = header.map(function (h, j) {
      var nonEmpty = 0, numeric = 0, distinct = {}, nd = 0;
      for (var r = 0; r < body.length; r++) {
        var s = String(body[r][j]).trim();
        if (s === "") continue;
        nonEmpty++;
        if (!isNaN(toNum(s))) numeric++;
        if (nd <= 50 && !distinct[s]) { distinct[s] = 1; nd++; }
      }
      return { name: h, numeric: nonEmpty > 0 && numeric / nonEmpty >= 0.95, nonEmpty: nonEmpty, fewValues: nd <= 50, distinct: Object.keys(distinct) };
    });
    return { name: name, header: header, rows: body, cols: cols, skipped: skipped, sampled: sampled, total: total };
  }

  // ---------------------------------------------------------------- 1단계 UI
  function resetSteps() {
    show($("step2"), false); show($("step3"), false);
    $("meta-result").innerHTML = "";
    if (S) { S.result = null; S.metaResults = []; }
  }

  function afterLoad(data) {
    S = data; S.result = null; S.metaResults = [];
    var labelSel = $("label-col"); labelSel.innerHTML = "";
    var pref = /^(class|label|labels|target|y|malware|is_malware|is_malicious|악성|라벨|정답)$/i;
    var namedOk = data.cols.filter(function (c) { return pref.test(c.name) && c.fewValues && c.distinct.length >= 2 && c.distinct.length <= 20; });
    var namedOne = data.cols.filter(function (c) { return pref.test(c.name) && c.distinct.length < 2; })[0];
    if (!namedOk.length && namedOne)
      throw new Error("라벨 열 '" + namedOne.name + "'의 값이 한 가지(" + (namedOne.distinct[0] || "빈 값") + ")뿐입니다. 정상과 악성이 모두 들어 있는 데이터가 필요합니다.");
    var cands = data.cols.filter(function (c) { return c.fewValues && c.distinct.length >= 2 && c.distinct.length <= 20; });
    if (!cands.length) throw new Error("값이 2~20가지인 열이 없어 라벨 열을 찾지 못했습니다. 정상/악성을 나타내는 열이 있는지 확인해 주세요.");
    cands.sort(function (a, b) { return (pref.test(b.name) ? 1 : 0) - (pref.test(a.name) ? 1 : 0); });
    cands.forEach(function (c) { var o = el("option", "", c.name); o.value = c.name; labelSel.appendChild(o); });
    fillPos();
    var note = data.rows.length.toLocaleString() + "행 · " + data.header.length + "열을 읽었습니다.";
    if (data.skipped) note += " 열 개수가 맞지 않는 " + data.skipped.toLocaleString() + "행은 건너뛰었습니다.";
    if (data.sampled) note += " 전체 " + data.total.toLocaleString() + "행 가운데 " + MAX_ROWS.toLocaleString() + "행을 고정 시드로 뽑아 계산합니다.";
    setMsg($("load-msg"), note, "ok");
    show($("label-box"), true);
    resetSteps();
  }

  function fillPos() {
    var col = S.cols.filter(function (c) { return c.name === $("label-col").value; })[0];
    var sel = $("pos-val"); sel.innerHTML = "";
    var vals = col.distinct.slice().sort();
    var guess = /mal|attack|malicious|악성|^1$|^true$|^yes$/i;
    vals.sort(function (a, b) { return (guess.test(b) ? 1 : 0) - (guess.test(a) ? 1 : 0); });
    vals.forEach(function (v) { var o = el("option", "", v); o.value = v; sel.appendChild(o); });
  }

  function readFile(file) {
    setMsg($("load-msg"), "");
    show($("label-box"), false); resetSteps(); S = null;
    if (!file) return;
    if (file.size === 0) { setMsg($("load-msg"), "빈 파일입니다. 내용이 있는 CSV 파일을 골라 주세요.", "err"); return; }
    if (file.size > MAX_BYTES) { setMsg($("load-msg"), "파일이 100MB보다 큽니다. 일부 행만 잘라 다시 넣어 주세요.", "err"); return; }
    setMsg($("load-msg"), "파일을 읽는 중…");
    var fr = new FileReader();
    fr.onerror = function () { setMsg($("load-msg"), "파일을 읽지 못했습니다. 다른 파일로 다시 시도해 주세요.", "err"); };
    fr.onload = function () {
      try {
        var text = String(fr.result);
        if (/\u0000/.test(text.slice(0, 2000))) throw new Error("글자로 된 CSV 파일이 아닌 것 같습니다(이미지·압축 파일 등). CSV로 저장한 파일을 넣어 주세요.");
        afterLoad(loadText(text, file.name));
      } catch (e) { setMsg($("load-msg"), e.message || String(e), "err"); }
    };
    fr.readAsText(file);
  }

  // ---------------------------------------------------------------- 계산
  function labelsFor(labelName, posVal) {
    var j = S.header.indexOf(labelName);
    return S.rows.map(function (r) { return String(r[j]).trim() === posVal ? 1 : 0; });
  }

  // 깊이 1 결정트리: 학습 70%에서 기준값을 정하고 나머지 30%에서 잰다.
  function stump(values, y, train, test) {
    var pairs = [], i;
    for (i = 0; i < train.length; i++) {
      var v = values[train[i]];
      if (!isNaN(v)) pairs.push([v, y[train[i]]]);
    }
    var trainPos = 0;
    for (i = 0; i < train.length; i++) trainPos += y[train[i]];
    var majority = trainPos * 2 >= train.length ? 1 : 0;
    if (pairs.length < 10) return null;
    pairs.sort(function (a, b) { return a[0] - b[0]; });
    var n = pairs.length, P = 0;
    for (i = 0; i < n; i++) P += pairs[i][1];
    var N = n - P;
    if (pairs[0][0] === pairs[n - 1][0]) return { constant: true };
    if (P === 0 || N === 0) return null;   // 값이 있는 행이 한쪽 라벨뿐이면 기준값을 정할 수 없음
    // 기준값은 균형 정확도(악성 정답률과 정상 정답률의 평균)가 가장 높은 곳으로 정한다
    var lp = 0, lc = 0, best = -1, thr = null, leftPos = 0;
    for (i = 0; i < n - 1; i++) {
      lc++; lp += pairs[i][1];
      if (pairs[i][0] === pairs[i + 1][0]) continue;
      var ln = lc - lp;
      var baA = ((P - lp) / P + ln / N) / 2;            // 왼쪽 정상, 오른쪽 악성
      var baB = (lp / P + (N - ln) / N) / 2;            // 왼쪽 악성, 오른쪽 정상
      if (baA > best) { best = baA; thr = (pairs[i][0] + pairs[i + 1][0]) / 2; leftPos = 0; }
      if (baB > best) { best = baB; thr = (pairs[i][0] + pairs[i + 1][0]) / 2; leftPos = 1; }
    }
    var correct = 0, missing = 0, tp = 0, tn = 0, nP = 0, nN = 0;
    for (i = 0; i < test.length; i++) {
      var t = values[test[i]], pred, truth = y[test[i]];
      if (isNaN(t)) { pred = majority; missing++; } else pred = t <= thr ? leftPos : 1 - leftPos;
      if (pred === truth) correct++;
      if (truth) { nP++; if (pred) tp++; } else { nN++; if (!pred) tn++; }
    }
    return { acc: correct / test.length, bacc: (tp / nP + tn / nN) / 2, thr: thr, leftPos: leftPos, missing: missing };
  }

  function aucOf(scores, y) {
    // 동점은 평균 순위로 처리한 Mann-Whitney AUC
    var n = scores.length, idx = new Array(n), i;
    for (i = 0; i < n; i++) idx[i] = i;
    idx.sort(function (a, b) { return scores[a] - scores[b]; });
    var ranks = new Array(n), k = 0;
    while (k < n) {
      var m = k;
      while (m + 1 < n && scores[idx[m + 1]] === scores[idx[k]]) m++;
      var r = (k + m) / 2 + 1;
      for (var q = k; q <= m; q++) ranks[idx[q]] = r;
      k = m + 1;
    }
    var nPos = 0, sumR = 0;
    for (i = 0; i < n; i++) if (y[i]) { nPos++; sumR += ranks[i]; }
    var nNeg = n - nPos;
    if (!nPos || !nNeg) return NaN;
    return (sumR - nPos * (nPos + 1) / 2) / (nPos * nNeg);
  }

  function levelOf(bacc) {
    if (bacc >= LEVEL.dangerBacc) return { key: "danger", text: "거의 완전 분리" };
    if (bacc >= LEVEL.warnBacc) return { key: "warn", text: "지름길 후보" };
    return { key: "ok", text: "보통" };
  }

  function runCheck() {
    var labelName = $("label-col").value, posVal = $("pos-val").value;
    var y = labelsFor(labelName, posVal);
    var nPos = y.reduce(function (a, b) { return a + b; }, 0);
    if (nPos === 0 || nPos === y.length) throw new Error("라벨이 한 가지 값뿐입니다. 정상과 악성이 모두 들어 있는 데이터가 필요합니다.");
    if (Math.min(nPos, y.length - nPos) < 5) throw new Error("정상 또는 악성 행이 5개 미만이라 점검할 수 없습니다.");
    var order = shuffledIndex(y.length, SEED), train = [], test = [], i;
    [1, 0].forEach(function (cls) {
      var part = order.filter(function (k) { return y[k] === cls; });
      var cut = Math.max(1, Math.min(part.length - 1, Math.round(part.length * TRAIN_RATIO)));
      train = train.concat(part.slice(0, cut)); test = test.concat(part.slice(cut));
    });
    var trainPos = 0;
    for (i = 0; i < train.length; i++) trainPos += y[train[i]];
    var majority = trainPos * 2 >= train.length ? 1 : 0, base = 0;
    for (i = 0; i < test.length; i++) if (y[test[i]] === majority) base++;
    base /= test.length;

    var labelIdx = S.header.indexOf(labelName);
    var feats = [], constNames = [];
    S.cols.forEach(function (c, j) {
      if (j === labelIdx || !c.numeric) return;
      if (isSingle(c)) { constNames.push(c.name); return; }
      var vals = S.rows.map(function (r) { return toNum(r[j]); });
      var s = stump(vals, y, train, test);
      if (!s) return;
      if (s.constant) { constNames.push(c.name); return; }   // 학습 쪽 70%에서만 값이 하나뿐인 경우
      var gap = s.acc - base;
      feats.push({ name: c.name, acc: s.acc, bacc: s.bacc, gap: gap, thr: s.thr, leftPos: s.leftPos, missing: s.missing, level: levelOf(s.bacc) });
    });
    feats.sort(function (a, b) { return b.bacc - a.bacc || b.acc - a.acc || (a.name < b.name ? -1 : 1); });
    S.result = { labelName: labelName, posVal: posVal, y: y, train: train, test: test, base: base, feats: feats,
                 constNames: constNames, nPos: nPos, majority: majority };
    S.metaResults = [];
    renderFeatures(false);
    fillMeta();
    show($("step2"), true); show($("step3"), true);
    $("step2").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function ruleText(f, r) {
    var pos = r.posVal, neg = "정상(그 외)";
    var left = f.leftPos ? "악성(" + pos + ")" : neg, right = f.leftPos ? neg : "악성(" + pos + ")";
    return f.name + " ≤ " + fmt(f.thr) + " → " + left + ", 아니면 " + right;
  }

  function renderFeatures(all) {
    var r = S.result, tb = $("feat-table").querySelector("tbody"), v = $("verdict");
    tb.innerHTML = ""; v.innerHTML = "";
    if (!r.feats.length) {
      v.className = "verdict ok";
      v.appendChild(el("p", "v-main", r.constNames.length
        ? "값이 여러 가지인 숫자 특징이 없어 이 단계 점검을 할 수 없습니다."
        : "숫자로 된 특징 열이 없어 이 단계 점검을 할 수 없습니다."));
      if (r.constNames.length) v.appendChild(el("p", "v-sub", "값이 하나뿐이라 뺀 특징 " + r.constNames.length + "개: " + nameList(r.constNames)));
      v.appendChild(el("p", "v-sub", "글자로 된 열은 3단계에서 라벨과 얽혀 있는지 확인할 수 있습니다."));
      show($("btn-more"), false);
      return;
    }
    var top = r.feats[0];
    v.className = "verdict " + top.level.key;
    var main = top.level.key === "danger"
      ? "특징 하나로 거의 완전히 갈립니다: " + top.name + " 하나로 균형 정확도 " + pct(top.bacc)
      : top.level.key === "warn"
        ? "지름길 후보가 있습니다: " + top.name + " 하나로 균형 정확도 " + pct(top.bacc)
        : "특징 하나로는 잘 갈리지 않습니다 (가장 높은 " + top.name + " 균형 정확도 " + pct(top.bacc) + ")";
    v.appendChild(el("p", "v-main", main));
    v.appendChild(el("p", "v-sub", "정확도 " + pct(top.acc) + " (다수 클래스 기준선 " + pct(r.base) + " 대비 " + pp(top.gap) + ") · 규칙: " + ruleText(top, r)));
    var nD = r.feats.filter(function (f) { return f.level.key === "danger"; }).length;
    var nW = r.feats.filter(function (f) { return f.level.key === "warn"; }).length;
    v.appendChild(el("p", "v-sub", "숫자 특징 " + r.feats.length + "개 가운데 거의 완전 분리 " + nD + "개, 지름길 후보 " + nW + "개" +
      (r.constNames.length ? " · 값이 하나뿐이라 뺀 특징 " + r.constNames.length + "개(" + nameList(r.constNames) + ")" : "") +
      " · 판정 기준(앱이 정한 값): 균형 정확도 99% 이상이면 거의 완전 분리, 85% 이상이면 지름길 후보"));
    var list = all ? r.feats : r.feats.slice(0, SHOW_TOP);
    list.forEach(function (f, i) {
      var tr = document.createElement("tr");
      tr.appendChild(el("td", "num-cell", String(i + 1)));
      tr.appendChild(el("td", "name-cell", f.name));
      tr.appendChild(el("td", "num-cell strong", pct(f.bacc)));
      tr.appendChild(el("td", "num-cell", pct(f.acc)));
      tr.appendChild(el("td", "num-cell", pp(f.gap)));
      tr.appendChild(el("td", "rule-cell", ruleText(f, r)));
      var td = el("td"); td.appendChild(el("span", "tag " + f.level.key, f.level.text)); tr.appendChild(td);
      tb.appendChild(tr);
    });
    show($("btn-more"), !all && r.feats.length > SHOW_TOP);
  }

  // ---------------------------------------------------------------- 3단계
  function fillMeta() {
    var sel = $("meta-col"); sel.innerHTML = "";
    var labelName = S.result.labelName;
    var hint = /year|date|time|연도|날짜|source|host|machine|env|file|name|category|family|collect|수집/i;
    var cols = S.cols.filter(function (c) { return c.name !== labelName && !isSingle(c); });
    var singles = S.cols.filter(function (c) { return c.name !== labelName && isSingle(c); }).map(function (c) { return c.name; });
    $("meta-note").textContent = singles.length
      ? "값이 하나뿐이라 확인할 것이 없는 열 " + singles.length + "개는 목록에서 뺐습니다: " + nameList(singles)
      : "";
    $("btn-meta").disabled = !cols.length;
    if (!cols.length) $("meta-note").textContent = "라벨 말고는 확인할 수 있는 열이 없습니다." + (singles.length ? " (값이 하나뿐인 열 " + singles.length + "개 제외)" : "");
    cols.sort(function (a, b) {
      var sa = (!a.numeric ? 2 : 0) + (hint.test(a.name) ? 1 : 0), sb = (!b.numeric ? 2 : 0) + (hint.test(b.name) ? 1 : 0);
      return sb - sa;
    });
    cols.forEach(function (c) {
      var o = el("option", "", c.name + (c.numeric ? "" : " (글자 열)")); o.value = c.name; sel.appendChild(o);
    });
  }

  function runMeta() {
    var r = S.result, name = $("meta-col").value, j = S.header.indexOf(name);
    if (j < 0) throw new Error("확인할 열을 골라 주세요.");
    var col = S.cols[j], scores, how;
    if (isSingle(col)) throw new Error(name + " 열은 값이 하나뿐이라 라벨에 대해 알려 주는 것이 없습니다.");
    var numVals = S.rows.map(function (row) { return toNum(row[j]); });
    if (col.numeric) {
      var trainMean = 0, cnt = 0, i;
      for (i = 0; i < r.train.length; i++) if (!isNaN(numVals[r.train[i]])) { trainMean += numVals[r.train[i]]; cnt++; }
      trainMean = cnt ? trainMean / cnt : 0;
      scores = r.test.map(function (k) { return isNaN(numVals[k]) ? trainMean : numVals[k]; });
      how = "값 크기 그대로";
    } else {
      // 값마다 학습 70%의 악성 비율을 점수로 쓴다(처음 보는 값은 전체 악성 비율)
      var cntPos = {}, cntAll = {}, tp = 0;
      r.train.forEach(function (k) {
        var key = String(S.rows[k][j]).trim();
        cntAll[key] = (cntAll[key] || 0) + 1; cntPos[key] = (cntPos[key] || 0) + r.y[k]; tp += r.y[k];
      });
      var prior = tp / r.train.length;
      scores = r.test.map(function (k) {
        var key = String(S.rows[k][j]).trim();
        return cntAll[key] ? cntPos[key] / cntAll[key] : prior;
      });
      how = "값별 악성 비율";
    }
    var yt = r.test.map(function (k) { return r.y[k]; });
    var auc = aucOf(scores, yt);
    if (isNaN(auc)) throw new Error("시험용 30%에 정상이나 악성이 없어 AUC를 계산할 수 없습니다.");
    var flipped = auc < 0.5, a = Math.max(auc, 1 - auc);
    var distinct = {}, nd = 0;
    S.rows.forEach(function (row) { var s = String(row[j]).trim(); if (!distinct[s]) { distinct[s] = 1; nd++; } });
    var idLike = nd > S.rows.length * 0.5;
    var level = a >= LEVEL.metaDanger ? "danger" : a >= LEVEL.metaWarn ? "warn" : "ok";
    var res = { name: name, auc: a, flipped: flipped, how: how, level: level, idLike: idLike, distinct: nd, numeric: col.numeric };
    S.metaResults = S.metaResults.filter(function (m) { return m.name !== name; });
    S.metaResults.push(res);
    renderMeta();
  }

  function metaSentence(m) {
    var s = m.level === "danger" ? "라벨과 강하게 얽혀 있습니다." : m.level === "warn" ? "라벨과 어느 정도 얽혀 있습니다." : "라벨과 거의 얽혀 있지 않습니다.";
    if (m.idLike && m.level === "danger") s += " 행마다 값이 거의 다른 열인데도 라벨이 갈립니다. 파일 이름처럼 라벨 정보가 들어간 열인지 확인하세요.";
    return s;
  }

  function renderMeta() {
    var box = $("meta-result"); box.innerHTML = "";
    S.metaResults.forEach(function (m) {
      var d = el("div", "meta-item " + m.level);
      d.appendChild(el("p", "v-main", m.name + " 하나로 ROC-AUC " + m.auc.toFixed(3)));
      d.appendChild(el("p", "v-sub", metaSentence(m) + " (계산: " + m.how + (m.flipped ? ", 값이 작을수록 악성 쪽" : "") + " · 서로 다른 값 " + m.distinct.toLocaleString() + "개)"));
      box.appendChild(d);
    });
  }

  // ---------------------------------------------------------------- 저장
  function download(name, text, type) {
    var blob = new Blob([text], { type: type + ";charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function mdCell(s) { return String(s).replace(/\|/g, "\\|").replace(/\n/g, " "); }

  function reportMd() {
    var r = S.result, L = [];
    L.push("# 지름길 점검 결과", "");
    L.push("- 파일: " + mdCell(S.name) + " (" + S.rows.length + "행 · " + S.header.length + "열" + (S.sampled ? ", 전체 " + S.total + "행 중 표본" : "") + ")");
    L.push("- 라벨 열: " + mdCell(r.labelName) + " · 악성 값: " + mdCell(r.posVal) + " · 악성 " + r.nPos + "행 / 정상 " + (r.y.length - r.nPos) + "행");
    L.push("- 방법: 특징 하나와 기준값 하나(깊이 1 결정트리). 고정 시드 " + SEED + "로 섞고 정상·악성을 각각 70:30으로 나눠, 70%에서 균형 정확도가 가장 높은 기준값을 정하고 30%(" + r.test.length + "행)에서 측정");
    L.push("- 균형 정확도 = (악성 정답률 + 정상 정답률) ÷ 2. 찍기만 하면 50%라서 정상·악성 비율이 기울어도 비교할 수 있습니다.");
    L.push("- 다수 클래스 기준선(정확도): " + pct(r.base));
    if (r.constNames.length) L.push("- 값이 하나뿐이라 뺀 특징 " + r.constNames.length + "개: " + mdCell(r.constNames.join(", ")));
    L.push("");
    L.push("## 특징별 결과 (상위 " + Math.min(SHOW_TOP, r.feats.length) + "개)", "");
    L.push("| 순위 | 특징 | 균형 정확도 | 정확도 | 기준선 대비 | 규칙 | 판정 |", "| --- | --- | --- | --- | --- | --- | --- |");
    r.feats.slice(0, SHOW_TOP).forEach(function (f, i) {
      L.push("| " + (i + 1) + " | " + mdCell(f.name) + " | " + pct(f.bacc) + " | " + pct(f.acc) + " | " + pp(f.gap) + " | " + mdCell(ruleText(f, r)) + " | " + f.level.text + " |");
    });
    if (!r.feats.length) L.push("| - | 숫자 특징 없음 | | | | | |");
    L.push("", "## 메타데이터 결과", "");
    if (!S.metaResults.length) L.push("확인한 메타데이터 열이 없습니다.");
    else {
      L.push("| 열 | ROC-AUC | 판단 |", "| --- | --- | --- |");
      S.metaResults.forEach(function (m) { L.push("| " + mdCell(m.name) + " | " + m.auc.toFixed(3) + " | " + mdCell(metaSentence(m)) + " |"); });
    }
    L.push("", "## 바탕 논문과 한계", "");
    L.push("- 논문: 높은 탐지 성능은 무엇을 측정하는가 — 호스트 행위 기반 악성코드 탐지 평가의 네 층위 분석");
    L.push("- 기준점: CIC-MalMem-2022는 서비스 수 하나로 정확도 99.65%. DMBD 2025는 같은 점검을 통과(76.33%)했지만 수집 연도 하나로 ROC-AUC 0.907.");
    L.push("- 판정 기준(균형 정확도 99%·85%, AUC 0.9·0.7)은 이 앱이 정한 값입니다.");
    L.push("- 이 점검을 통과해도 데이터셋이 타당하다는 뜻은 아닙니다. 입력에 없는 교란은 이 점검으로 잡을 수 없습니다.");
    return L.join("\n") + "\n";
  }

  function reportCsv() {
    var r = S.result, q = function (s) { s = String(s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var L = ["rank,feature,balanced_accuracy,accuracy,gap_vs_baseline,threshold,left_is_malware,level"];
    r.feats.forEach(function (f, i) { L.push([i + 1, q(f.name), f.bacc.toFixed(6), f.acc.toFixed(6), f.gap.toFixed(6), f.thr, f.leftPos, q(f.level.text)].join(",")); });
    return "﻿" + L.join("\n") + "\n";
  }

  // ---------------------------------------------------------------- 연결
  function guard(fn, msgEl) {
    return function () {
      try { fn.apply(null, arguments); }
      catch (e) { setMsg(msgEl || $("load-msg"), e.message || String(e), "err"); if (msgEl && msgEl !== $("load-msg")) show(msgEl, true); }
    };
  }

  $("btn-example").addEventListener("click", guard(function () {
    $("file").value = "";
    if (!window.EXAMPLE_CSV) throw new Error("예시 데이터 파일(example-data.js)을 불러오지 못했습니다.");
    afterLoad(loadText(window.EXAMPLE_CSV, "CIC-MalMem-2022 축소본 (3,000행)"));
  }));
  $("file").addEventListener("change", function (e) { readFile(e.target.files && e.target.files[0]); });
  $("label-col").addEventListener("change", guard(function () { fillPos(); resetSteps(); }));
  $("pos-val").addEventListener("change", function () { resetSteps(); });
  $("btn-run").addEventListener("click", function () {
    var b = $("btn-run"); b.disabled = true; b.textContent = "계산 중…";
    setTimeout(function () {
      try { runCheck(); setMsg($("load-msg"), $("load-msg").textContent, "ok"); }
      catch (e) { setMsg($("load-msg"), e.message || String(e), "err"); resetSteps(); }
      finally { b.disabled = false; b.textContent = "점검 시작"; }
    }, 30);
  });
  $("btn-more").addEventListener("click", function () { renderFeatures(true); });
  $("btn-meta").addEventListener("click", function () {
    try { runMeta(); }
    catch (e) {
      renderMeta();   // 앞서 확인한 결과는 그대로 두고 안내만 덧붙인다
      $("meta-result").appendChild(el("p", "msg err", e.message || String(e)));
    }
  });
  $("btn-save").addEventListener("click", function () { if (S && S.result) download("지름길-점검-결과.md", reportMd(), "text/markdown"); });
  $("btn-save-csv").addEventListener("click", function () { if (S && S.result) download("지름길-점검-특징별.csv", reportCsv(), "text/csv"); });

  // 테스트용 진입점
  window.__shortcut = { parseCSV: parseCSV, loadText: loadText, aucOf: aucOf, stump: stump, reportMd: function () { return reportMd(); }, state: function () { return S; } };
})();
