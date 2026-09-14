(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const state = { data: null, page: 'today', taskFilter: '未対応' };
  const TASK_SECTIONS = ['期限切れ', '今日が期限', '承認待ち', 'あと2日以内', '動いていないタスク'];
  const PRIORITY_SECTIONS = ['期限切れ', '今日が期限', '承認待ち'];
  const esc = (v) => String(v ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const arr = (v) => Array.isArray(v) ? v : [];
  const has = (v) => v !== null && v !== undefined && v !== '';
  const text = (v) => has(v) ? esc(v) : '—';
  const date = (v) => v ? esc(String(v).replace('T', ' ').replace(/:\d\d(?:[+-].*)?$/, '')) : '日時なし';
  const safeUrl = (v) => /^https?:\/\//i.test(String(v || '')) ? String(v) : '';
  const updatedAt = (v) => {
    const value = new Date(v);
    if (!v || Number.isNaN(value.getTime())) return '—';
    return `${value.getMonth() + 1}/${value.getDate()} ${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
  };
  const speaker = (v) => state.data?.speaker_names?.[v] || v;

  // 外部リンクを安全に生成する。
  function notion(url) {
    const value = safeUrl(url);
    return value ? `<a class="link" href="${esc(value)}" target="_blank" rel="noopener">Notionで開く →</a>` : '';
  }

  function status(value) {
    return `<span class="status ${esc(value)}">${text(value)}</span>`;
  }

  function list(values) {
    return arr(values).length ? `<ul class="list">${arr(values).map((v) => `<li>${text(v)}</li>`).join('')}</ul>` : '<p class="mini">情報はありません</p>';
  }

  function setView(html) {
    $('#view').innerHTML = html;
    $('#view').focus({ preventScroll: true });
    bindView();
  }

  // 復号キー用 IndexedDB（既存仕様）を操作する。
  function db() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('work-brief-key', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getStored() {
    try {
      const database = await db();
      return await new Promise((resolve, reject) => {
        const request = database.transaction('keys').objectStore('keys').get('main');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } catch { return null; }
  }

  async function putStored(value) {
    const database = await db();
    return new Promise((resolve, reject) => {
      const request = database.transaction('keys', 'readwrite').objectStore('keys').put(value, 'main');
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
  }

  async function clearStored() {
    try {
      const database = await db();
      await new Promise((resolve, reject) => {
        const request = database.transaction('keys', 'readwrite').objectStore('keys').clear();
        request.onsuccess = resolve;
        request.onerror = reject;
      });
    } catch {}
  }

  // PBKDF2 → AES-GCM → gzip の既存復号方式を維持する。
  const b64 = (v) => Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
  async function derive(pass, envelope) {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(envelope.salt), iterations: Number(envelope.iter) }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  }

  async function decode(envelope, key) {
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(envelope.iv) }, key, b64(envelope.ct));
    let stream = new Blob([bytes]).stream();
    if (envelope.gzip) {
      if (!window.DecompressionStream) throw new Error('このブラウザはgzip展開に対応していません');
      stream = stream.pipeThrough(new DecompressionStream('gzip'));
    }
    return JSON.parse(await new Response(stream).text());
  }

  async function envelope() {
    const response = await fetch('data.enc.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error('データを取得できません');
    return response.json();
  }

  async function unlock(pass) {
    const encrypted = await envelope();
    const saved = await getStored();
    try {
      let key;
      if (!pass && saved && saved.salt === encrypted.salt) key = saved.key;
      else if (pass) key = await derive(pass, encrypted);
      else throw new Error('need');
      const data = await decode(encrypted, key);
      if (pass) await putStored({ salt: encrypted.salt, key });
      state.data = data;
      $('#lock').classList.add('hidden');
      $('#app').classList.remove('hidden');
      $('#updated').textContent = `最終更新: ${updatedAt(data.generated_at)}`;
      render();
    } catch (error) {
      if (!pass && saved) await clearStored();
      if (pass) throw error;
    }
  }

  function render() {
    document.querySelectorAll('.bottom-nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === state.page));
    ({ today, tasks, threads, people, daily, knowledge }[state.page] || today)();
  }

  // 対応対象の節だけを集計する。
  function today() {
    const briefing = state.data.briefing || {};
    const sections = arr(briefing.sections).slice();
    const count = sections.filter((s) => TASK_SECTIONS.includes(s.title)).reduce((n, s) => n + arr(s.items).length, 0);
    sections.sort((a, b) => (PRIORITY_SECTIONS.indexOf(a.title) + 1 || 99) - (PRIORITY_SECTIONS.indexOf(b.title) + 1 || 99));
    setView(`<div class="page-head"><div><h1>今日やること</h1><p>${text(briefing.date || state.data.today)} のブリーフィング</p></div></div><section class="panel hero"><div class="eyebrow">要対応</div><div class="count">${count}<small> 件</small></div><div class="meta">Notionの情報を読み取り専用で表示しています</div></section>${sections.length ? sections.map((s) => `<section class="panel ${PRIORITY_SECTIONS.includes(s.title) ? 'urgent' : ''}"><div class="section-head"><h2>${text(s.emoji)} ${text(s.title)}</h2><span class="badge">${arr(s.items).length}件</span></div><ul class="items">${arr(s.items).length ? arr(s.items).map((i) => `<li class="item"><div class="item-title">${text(i.text)}</div>${i.note ? `<div class="item-note">${text(i.note)}</div>` : ''}${notion(i.url)}</li>`).join('') : '<li class="empty">表示する項目はありません</li>'}</ul></section>`).join('') : '<div class="empty">今日のブリーフィングはありません</div>'}`);
  }

  const taskMatch = (task, filter) => filter === '未対応' ? ['未対応', '承認待ち', '期限切れ'].includes(task.status) : filter === 'すべて' || task.status === filter;
  function tasks() {
    const all = arr(state.data.tasks).filter((t) => taskMatch(t, state.taskFilter));
    setView(`<div class="page-head"><div><h1>タスク</h1><p>対応・確認が必要なものです。変更はNotionで行います。</p></div></div><button class="filter" data-action="task-filter"><span>${esc(state.taskFilter)}</span><span>絞り込み ⌄</span></button>${all.length ? all.map((t) => `<article class="card"><div class="task-top"><div class="row-main"><div class="item-title">${text(t.title)}</div><div class="meta">${text(t.genre)} ${t.person ? `・${text(t.person)}` : ''}</div></div>${status(t.status)}</div><div class="due">${t.due ? `期限: ${date(t.due)}` : '期限なし'}</div>${t.quote ? `<div class="quote">${text(t.quote)}</div>` : ''}${notion(t.url)}</article>`).join('') : '<div class="empty">表示するタスクはありません</div>'}`);
  }

  function threads() {
    const all = arr(state.data.threads);
    setView(`<div class="page-head"><div><h1>議題</h1><p>次アクションを軸に確認できます。</p></div></div>${all.length ? all.map((t) => `<article class="card"><div class="row"><div class="row-main"><h2>${text(t.name)}</h2><div class="meta">${text(t.genre)} ・ ${text(t.priority)} ・ ${text(t.due)}</div></div>${status(t.status)}</div><div class="next">次: ${text(t.next_action)}</div>${arr(t.members).length ? `<div class="mini">関係者: ${arr(t.members).map(text).join('・')}</div>` : ''}<details class="details"><summary>履歴を表示</summary><div class="history">${text(t.history)}</div></details>${notion(t.url)}</article>`).join('') : '<div class="empty">議題はありません</div>'}`);
  }

  // メモはエスケープ後に太字だけを変換し、改行はCSSで保つ。
  function memoHtml(value) { return esc(value || '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'); }
  function people() {
    const all = arr(state.data.people).slice().sort((a, b) => (/^未設定/.test(b.name) ? 1 : 0) - (/^未設定/.test(a.name) ? 1 : 0));
    setView(`<div class="page-head"><div><h1>人物</h1><p>「未設定」はNotionで名前を紐付けてください。</p></div></div>${all.length ? all.map((p, i) => {
      const attrs = [p.org, p.relation].filter(has).map(text).join('・');
      const memo = has(p.memo) ? `<div class="person-memo mini is-collapsed" data-memo-content="${i}" style="white-space:pre-line;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden">${memoHtml(p.memo)}</div><button class="memo-toggle" data-action="memo-toggle" data-memo="${i}" aria-expanded="false">続きを読む</button>` : '';
      return `<article class="card ${/^未設定/.test(p.name || '') ? 'name-unset' : ''}"><div class="row"><div class="row-main"><h2>${text(p.name)}</h2>${attrs ? `<div class="meta">${attrs}</div>` : ''}</div><span class="badge">会話 ${Number(p.count) || 0}件</span></div>${p.promise ? `<p class="mini">約束: ${text(p.promise)}</p>` : ''}${p.caution ? `<p class="mini">注意: ${text(p.caution)}</p>` : ''}${memo}${notion(p.url)}</article>`;
    }).join('') : '<div class="empty">人物情報はありません</div>'}`);
  }

  function daily() {
    const all = arr(state.data.daily);
    setView(`<div class="page-head"><div><h1>記録</h1><p>日次ログと会話の整理。</p></div></div>${all.length ? all.map((d) => `<article class="card daily-card"><div class="row"><h2>${text(d.date)}</h2><span class="badge">${text(d.tone)}</span></div><p class="summary">${text(d.summary)}</p><div class="stats"><span class="stat">会話 ${Number(d.speech_min) || 0}分</span><span class="stat">タスク ${Number(d.task_count) || 0}</span><span class="stat">リスク ${Number(d.risk_count) || 0}</span></div><button class="open-row" data-detail="${esc(d.date)}">詳細を開く</button></article>`).join('') : '<div class="empty">記録はありません</div>'}`);
  }

  // 内部統計キーを表示用の日本語ラベルへ変換する。
  function formattedStats(stats) {
    return [['recorded_min', '録音', '分'], ['speech_min', '発話', '分'], ['sessions', '会話', '件'], ['utterances', '発話数', '']]
      .filter(([key]) => has(stats?.[key]))
      .map(([key, label, unit]) => `<span class="stat">${label} ${Math.round(Number(stats[key]))}${unit}</span>`).join('');
  }

  function names(labels) { return arr(labels).map((label) => text(speaker(label))).join('・'); }
  function dailyDetail(day) {
    const d = (state.data.daily_detail || {})[day];
    if (!d) return;
    const risks = arr(d.risks), meetings = arr(d.meetings), research = arr(d.research);
    setView(`<div class="page-head"><div><button class="plain-button" data-back="daily" aria-label="記録へ戻る">←</button><h1>${text(day)} の記録</h1><p>${text(d.tone)}</p></div></div><article class="panel"><p>${text(d.summary)}</p><div class="stats">${formattedStats(d.stats)}</div>${notion(d.notion_url)}</article>${risks.length ? `<h2 class="subsection">リスク</h2>${risks.map((r) => `<article class="card risk-${r.severity === '高' ? 'high' : r.severity === '中' ? 'mid' : 'low'}"><div class="risk-title">${text(r.severity)} ・ ${text(r.category)}</div><p class="mini">${text(speaker(r.who))} ・ ${text(r.why)}</p><p class="mini">対応: ${text(r.action)}</p>${r.quote ? `<div class="quote">${text(r.quote)}</div>` : ''}</article>`).join('')}` : ''}<h2 class="subsection">決定・気づき</h2><section class="panel"><h3>決定</h3>${list(d.decisions)}<h3>気づき</h3>${list(d.insights)}</section>${meetings.length ? `<h2 class="subsection">会議</h2>${meetings.map((m) => `<article class="card"><h3>${text(m.title)}</h3><p class="mini">${text(m.time)} ・ ${text(m.kind)} / ${text(m.purpose)}</p>${arr(m.attendees).length ? `<p class="mini">参加者: ${names(m.attendees)}</p>` : ''}${arr(m.agenda).map((a) => `<div class="item"><b>${text(a.topic)}</b><p class="mini">${text(a.discussion)}</p><p class="mini">結論: ${text(a.conclusion)}</p></div>`).join('')}</article>`).join('')}` : ''}<h2 class="subsection">調べておいたこと</h2>${arr(d.questions).map((q) => `<article class="card"><h3>${text(q.question)}</h3><p class="mini">${text(q.why)}</p>${research.filter((r) => r.question === q.question).map((r) => `<div class="item"><p>${text(r.answer)}</p>${list(r.key_points)}${arr(r.sources).map((s) => notion(s.url)).join('')}</div>`).join('')}</article>`).join('') || '<p class="empty">情報はありません</p>'}<h2 class="subsection">会話</h2>${arr(d.sessions).map((s) => `<article class="card"><h3>${text(s.title)}</h3><p class="mini">${text(s.time)} ・ ${text(s.place)}</p>${arr(s.participants).length ? `<p class="mini">参加者: ${names(s.participants)}</p>` : ''}<p class="mini">${text(s.summary)}</p>${list(s.points)}</article>`).join('') || '<p class="empty">情報はありません</p>'}<h2 class="subsection">マインドマップ</h2><section class="panel mindmap">${mindmap(d.mindmap)}</section>`);
  }

  function mindmap(value) {
    const lines = String(value || '').split('\n').filter(Boolean);
    return lines.length ? lines.map((line) => `<div style="padding-left:${Math.min((line.match(/^\s*/) || [''])[0].length, 10) * 10}px">・ ${esc(line.trim().replace(/^[-*]\s*/, ''))}</div>`).join('') : '<p class="mini">情報はありません</p>';
  }

  function markdown(value) {
    let output = memoHtml(value);
    return output.replace(/^### (.*)$/gm, '<h3>$1</h3>').replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h2>$1</h2>').replace(/^> (.*)$/gm, '<blockquote>$1</blockquote>').replace(/^[-*] (.*)$/gm, '<li>$1</li>').replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>').replace(/\n/g, '<br>');
  }

  function knowledge() {
    const all = arr(state.data.knowledge);
    setView(`<div class="page-head"><div><h1>ナレッジ</h1><p>現場で使うメモと記録。</p></div></div>${all.length ? all.map((k, i) => `<article class="card"><h2>${text(k.name)}</h2><div class="meta">更新: ${text(k.updated)}</div><button class="open-row" data-knowledge="${i}">開く</button></article>`).join('') : '<div class="empty">ナレッジはありません</div>'}`);
  }
  function knowledgeDetail(i) {
    const k = arr(state.data.knowledge)[i];
    if (k) setView(`<div class="page-head"><div><button class="plain-button" data-back="knowledge" aria-label="ナレッジへ戻る">←</button><h1>${text(k.name)}</h1><p>更新: ${text(k.updated)}</p></div></div><article class="panel markdown">${markdown(k.text)}</article>`);
  }

  function openSheet(html) { $('#sheet').innerHTML = html; $('#sheetBack').classList.add('show'); $('#sheet').classList.add('show'); }
  function closeSheet() { $('#sheetBack').classList.remove('show'); $('#sheet').classList.remove('show'); }
  function search() {
    openSheet('<div class="sheet-title">全文検索</div><input id="searchInput" placeholder="タスク・議題・人物・記録を検索" autocomplete="off"><div id="searchResults" class="mini">キーワードを入力してください</div>');
    const input = $('#searchInput'); input.focus();
    input.oninput = () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { $('#searchResults').textContent = 'キーワードを入力してください'; return; }
      const records = [];
      [['タスク', arr(state.data.tasks), (x) => `${x.title} ${x.quote}`], ['議題', arr(state.data.threads), (x) => `${x.name} ${x.next_action} ${x.history}`], ['人物', arr(state.data.people), (x) => `${x.name} ${x.memo}`], ['記録', arr(state.data.daily), (x) => `${x.date} ${x.summary}`]].forEach(([type, values, fields]) => values.forEach((x) => { if (fields(x).toLowerCase().includes(q)) records.push(`<div class="search-result"><b>${type}</b><br>${text(type === 'タスク' ? x.title : type === '議題' ? x.name : type === '人物' ? x.name : x.date)}<div class="mini">${text(type === '記録' ? x.summary : type === '議題' ? x.next_action : '')}</div></div>`); }));
      $('#searchResults').innerHTML = records.length ? records.join('') : '表示する項目はありません';
    };
  }

  // 各画面の操作を再描画後に結び付ける。
  function bindView() {
    document.querySelectorAll('[data-action="task-filter"]').forEach((b) => { b.onclick = () => openSheet(`<div class="sheet-title">タスクを絞り込む</div>${['未対応', '期限切れ', '承認待ち', '進行中', '対応済み', '保留', 'すべて'].map((f) => `<button class="${f === state.taskFilter ? 'selected' : ''}" data-filter="${f}">${f}</button>`).join('')}`); });
    document.querySelectorAll('[data-filter]').forEach((b) => { b.onclick = () => { state.taskFilter = b.dataset.filter; closeSheet(); tasks(); }; });
    document.querySelectorAll('[data-detail]').forEach((b) => { b.onclick = () => dailyDetail(b.dataset.detail); });
    document.querySelectorAll('[data-knowledge]').forEach((b) => { b.onclick = () => knowledgeDetail(Number(b.dataset.knowledge)); });
    document.querySelectorAll('[data-back]').forEach((b) => { b.onclick = () => { state.page = b.dataset.back; render(); }; });
    document.querySelectorAll('[data-action="memo-toggle"]').forEach((b) => { b.onclick = () => { const memo = document.querySelector(`[data-memo-content="${b.dataset.memo}"]`); const expanded = b.getAttribute('aria-expanded') === 'true'; memo.classList.toggle('is-collapsed', expanded); memo.style.display = expanded ? '-webkit-box' : 'block'; memo.style.webkitLineClamp = expanded ? '3' : 'unset'; b.setAttribute('aria-expanded', String(!expanded)); b.textContent = expanded ? '続きを読む' : '閉じる'; }; });
  }

  $('#sheetBack').onclick = closeSheet;
  $('#searchButton').onclick = search;
  $('#settingsButton').onclick = () => openSheet('<div class="sheet-title">設定</div><p class="mini">この端末に保存した復号用の鍵だけを削除できます。復号したデータや閲覧履歴は保存しません。</p><button id="forgetKey">この端末の鍵を消す</button>');
  document.querySelectorAll('.bottom-nav button').forEach((b) => { b.onclick = () => { state.page = b.dataset.page; render(); }; });
  $('#unlockForm').onsubmit = async (event) => { event.preventDefault(); const pass = $('#passphrase').value; $('#lockError').textContent = ''; if (!pass) return; try { await unlock(pass); $('#passphrase').value = ''; } catch { $('#lockError').textContent = '合言葉が違います。'; } };
  document.addEventListener('click', async (event) => { if (event.target.id === 'forgetKey') { await clearStored(); closeSheet(); } });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  unlock().catch(() => {});
})();
