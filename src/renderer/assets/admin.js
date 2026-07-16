// NutriDesk Admin-Modul (lazy) - wird NUR geladen wenn user.admin === true.
// Setzt window.AdminPanel (React-Komponente); dc-runtime mountet sie im <x-import>-Slot.
// Props: api(path,opts), toast(msg), user
(function () {
  var React = window.React;
  if (!React) { console.error('[admin] window.React fehlt'); return; }
  var h = React.createElement;
  var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef;

  // ---- Style-Helfer (globale CSS-Variablen der App) ----
  var box = { background: 'var(--panel)', border: '1px solid var(--cardbd)', borderRadius: '18px', boxShadow: 'var(--cardsh)' };
  function chip(active) {
    return { display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 14px', borderRadius: '11px', fontSize: '13.5px', fontWeight: 600, cursor: 'pointer', color: active ? '#0f1117' : 'var(--ink2)', background: active ? 'var(--acc)' : 'var(--chip)', border: '1px solid ' + (active ? 'var(--acc)' : 'var(--line3)') };
  }
  var btnPrimary = { display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '10px 16px', borderRadius: '11px', background: 'var(--acc)', color: '#0f1117', fontWeight: 600, fontSize: '13.5px', cursor: 'pointer', border: 'none' };
  var btnGhost = { display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '9px 14px', borderRadius: '10px', border: '1px solid var(--line3)', color: 'var(--ink2)', fontWeight: 600, fontSize: '13px', cursor: 'pointer', background: 'transparent' };
  var btnDanger = Object.assign({}, btnGhost, { color: '#f87171', borderColor: 'rgba(248,113,113,.4)' });
  var inputStyle = { width: '100%', background: 'var(--bg2)', border: '1px solid var(--line3)', borderRadius: '10px', padding: '11px 14px', color: 'var(--ink)', fontSize: '14px', fontFamily: "'Space Grotesk',sans-serif", outline: 'none', boxSizing: 'border-box' };
  var lbl = { display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--ink3)', letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: '6px' };
  var mono = { fontFamily: "'JetBrains Mono',monospace" };
  function head(title, sub) {
    return h('div', { style: { marginBottom: '20px' } },
      h('div', { style: { fontSize: '12.5px', fontWeight: 700, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--ink2)' } }, title),
      sub ? h('div', { style: { fontSize: '13px', color: 'var(--ink3)', marginTop: '4px' } }, sub) : null);
  }
  function empty(msg) { return h('div', { style: { padding: '46px', textAlign: 'center', color: 'var(--ink3)' } }, msg); }
  var SK_ID = 'nd-adm-sk';
  if (!document.getElementById(SK_ID)) {
    var stEl = document.createElement('style'); stEl.id = SK_ID;
    stEl.textContent = '@keyframes ndAdmSk{0%{background-position:200% 0}100%{background-position:-200% 0}}'
      + '.nd-adm-sk{background:linear-gradient(90deg,var(--chip) 25%,var(--line3) 50%,var(--chip) 75%);background-size:200% 100%;animation:ndAdmSk 1.4s ease-in-out infinite;border-radius:8px}';
    document.head.appendChild(stEl);
  }
  function skBar(w, hgt) { return h('div', { className: 'nd-adm-sk', style: { width: w, height: (hgt || 12) + 'px' } }); }
  function skRows(n, cols) {
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push(h('div', { key: 'sk' + i, style: { display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 0', borderBottom: '1px solid var(--chip)', opacity: Math.max(0.25, 1 - i * 0.11) } },
        h('div', { style: { flex: '1 1 auto' } }, skBar((55 + (i * 7) % 30) + '%', 13), h('div', { style: { height: '6px' } }), skBar('30%', 10)),
        (cols || []).map(function (w, j) { return h('div', { key: j, style: { flex: '0 0 auto', width: w } }, skBar('100%', 11)); })));
    }
    return h('div', null, out);
  }
  function Field(props) {
    return h('div', { style: { marginBottom: '14px' } }, h('span', { style: lbl }, props.label),
      h('input', { type: props.type || 'text', value: props.value, onChange: props.onChange, placeholder: props.placeholder || '', style: inputStyle }));
  }
  function Modal(props) {
    return h('div', { style: { position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }, onClick: props.onClose },
      h('div', { style: Object.assign({}, box, { width: '100%', maxWidth: props.wide ? '640px' : '440px', maxHeight: '86vh', overflow: 'auto', padding: '24px' }), onClick: function (e) { e.stopPropagation(); } },
        h('div', { style: { fontSize: '17px', fontWeight: 700, marginBottom: '18px' } }, props.title), props.children));
  }
  function useDebounced(fn, ms) { var t = useRef(0); return function (arg) { clearTimeout(t.current); t.current = setTimeout(function () { fn(arg); }, ms); }; }

  var TABS = [
    { id: 'users', label: 'Nutzer' }, { id: 'board', label: 'Board' }, { id: 'tickets', label: 'Tickets' },
    { id: 'logs', label: 'Logs' }, { id: 'conv', label: 'Konversationen' }, { id: 'foods', label: 'Lebensmittel' },
    { id: 'recipes', label: 'Rezepte' }
  ];

  // ---------------- Nutzer ----------------
  function UsersTab(props) {
    var api = props.api, toast = props.toast;
    var s0 = useState([]), users = s0[0], setUsers = s0[1];
    var s1 = useState(null), modal = s1[0], setModal = s1[1];
    var s2 = useState(false), busy = s2[0], setBusy = s2[1];
    var sL = useState(true), loading = sL[0], setLoading = sL[1];
    function load() { setLoading(true); api('/admin/users').then(function (u) { setUsers(Array.isArray(u) ? u : []); }).catch(function (e) { toast(e.message); }).then(function () { setLoading(false); }); }
    useEffect(function () { load(); }, []);
    function set(k, v) { setModal(function (m) { var n = Object.assign({}, m); n[k] = v; return n; }); }
    function openNew() { setModal({ mode: 'new', email: '', name: '', password: '', admin: false }); }
    function openEdit(u) { setModal({ mode: 'edit', id: u.id, name: u.name, email: u.email, admin: !!u.admin, password: '', quotaGb: String(Math.round((u.cloud_quota || 2147483648) / 1073741824 * 10) / 10) }); }
    function saveNew() {
      var m = modal; if (!m.email.trim() || !m.name.trim() || !m.password) { toast('Bitte E-Mail, Name und Passwort ausfüllen'); return; }
      if (m.password.length < 8) { toast('Passwort braucht mind. 8 Zeichen'); return; }
      setBusy(true); api('/admin/users', { method: 'POST', body: { email: m.email.trim(), name: m.name.trim(), password: m.password, admin: m.admin ? 1 : 0 } })
        .then(function () { toast('Nutzer angelegt'); setModal(null); load(); }).catch(function (e) { toast(e.message); }).then(function () { setBusy(false); });
    }
    function saveEdit() {
      var m = modal; if (!m.name.trim() || !m.email.trim()) { toast('Bitte Name und E-Mail ausfüllen'); return; }
      if (m.password && m.password.length < 8) { toast('Neues Passwort mind. 8 Zeichen'); return; }
      setBusy(true); api('/admin/users/' + m.id, { method: 'PUT', body: { name: m.name.trim(), email: m.email.trim(), admin: m.admin ? 1 : 0 } })
        .then(function () { return m.password ? api('/admin/users/' + m.id + '/password', { method: 'PUT', body: { password: m.password } }) : null; })
        .then(function () { toast('Nutzer aktualisiert'); setModal(null); load(); }).catch(function (e) { toast(e.message); }).then(function () { setBusy(false); });
    }
    function saveQuota() { var gb = parseFloat((modal.quotaGb || '0').replace(',', '.')); if (!(gb >= 0)) { toast('Ungültiger Wert'); return; } api('/admin/users/' + modal.id + '/quota', { method: 'PUT', body: { quota_gb: gb } }).then(function () { toast('Speicher: ' + gb + ' GB'); load(); }).catch(function (e) { toast(e.message); }); }
    function resetCd() { api('/admin/users/' + modal.id + '/cooldown', { method: 'DELETE' }).then(function () { toast('Cooldown zurückgesetzt'); }).catch(function (e) { toast(e.message); }); }
    function del() { api('/admin/users/' + modal.id, { method: 'DELETE' }).then(function () { toast('Nutzer gelöscht'); setModal(null); load(); }).catch(function (e) { toast(e.message); }); }
    var rows = users.map(function (u) {
      return h('div', { key: u.id, style: { display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 0', borderBottom: '1px solid var(--chip)' } },
        h('div', { style: { width: '40px', height: '40px', borderRadius: '12px', background: 'var(--chip)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto', fontWeight: 700, color: 'var(--ink3)' } }, (u.name || '?').slice(0, 1).toUpperCase()),
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
          h('div', { style: { fontSize: '14px', fontWeight: 600 } }, u.name, u.admin ? h('span', { style: { marginLeft: '8px', fontSize: '10px', fontWeight: 700, color: 'var(--acc)', background: 'var(--acc-bg)', border: '1px solid var(--acc-bd)', padding: '2px 7px', borderRadius: '6px' } }, 'ADMIN') : null),
          h('div', { style: { fontSize: '12px', color: 'var(--ink3)', marginTop: '2px' } }, u.email + (u.username ? ' · @' + u.username : ''))),
        h('div', { onClick: function () { openEdit(u); }, style: btnGhost }, 'Bearbeiten'));
    });
    var modalEl = null;
    if (modal && modal.mode === 'new') modalEl = h(Modal, { title: 'Nutzer anlegen', onClose: function () { setModal(null); } },
      h(Field, { label: 'E-Mail', value: modal.email, onChange: function (e) { set('email', e.target.value); } }),
      h(Field, { label: 'Name', value: modal.name, onChange: function (e) { set('name', e.target.value); } }),
      h(Field, { label: 'Passwort', type: 'password', value: modal.password, onChange: function (e) { set('password', e.target.value); }, placeholder: 'mind. 8 Zeichen' }),
      h('label', { style: { display: 'flex', alignItems: 'center', gap: '9px', margin: '4px 0 18px', cursor: 'pointer', fontSize: '13.5px' } }, h('input', { type: 'checkbox', checked: modal.admin, onChange: function (e) { set('admin', e.target.checked); } }), 'Administrator'),
      h('div', { style: { display: 'flex', gap: '10px', justifyContent: 'flex-end' } }, h('div', { onClick: function () { setModal(null); }, style: btnGhost }, 'Abbrechen'), h('div', { onClick: busy ? null : saveNew, style: Object.assign({}, btnPrimary, busy ? { opacity: .6 } : {}) }, busy ? 'Speichert …' : 'Anlegen')));
    else if (modal && modal.mode === 'edit') modalEl = h(Modal, { title: 'Nutzer bearbeiten', onClose: function () { setModal(null); } },
      h(Field, { label: 'Name', value: modal.name, onChange: function (e) { set('name', e.target.value); } }),
      h(Field, { label: 'E-Mail', value: modal.email, onChange: function (e) { set('email', e.target.value); } }),
      h(Field, { label: 'Neues Passwort (optional)', type: 'password', value: modal.password, onChange: function (e) { set('password', e.target.value); }, placeholder: 'leer = unverändert' }),
      h('label', { style: { display: 'flex', alignItems: 'center', gap: '9px', margin: '4px 0 14px', cursor: 'pointer', fontSize: '13.5px' } }, h('input', { type: 'checkbox', checked: modal.admin, onChange: function (e) { set('admin', e.target.checked); } }), 'Administrator'),
      h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '8px', marginBottom: '16px' } }, h('div', { style: { flex: 1 } }, h(Field, { label: 'Speicher (GB)', value: modal.quotaGb, onChange: function (e) { set('quotaGb', e.target.value); } })), h('div', { onClick: saveQuota, style: Object.assign({}, btnGhost, { marginBottom: '14px' }) }, 'Setzen')),
      h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' } }, h('div', { onClick: resetCd, style: btnGhost }, 'Cooldown reset'), h('div', { onClick: del, style: btnDanger }, 'Löschen'), h('div', { style: { flex: 1 } }), h('div', { onClick: function () { setModal(null); }, style: btnGhost }, 'Abbrechen'), h('div', { onClick: saveEdit, style: btnPrimary }, 'Speichern')));
    return h('div', null,
      h('div', { style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: '20px', flexWrap: 'wrap', gap: '14px' } },
        head('Nutzerverwaltung', loading ? 'Lädt …' : users.length + ' Konten · anlegen, bearbeiten & Passwörter setzen'),
        h('div', { onClick: openNew, style: btnPrimary }, '+ Nutzer anlegen')),
      h('div', { style: Object.assign({}, box, { padding: '8px 22px' }) },
        loading ? skRows(5, ['90px', '96px']) : (rows.length ? rows : empty('Keine Nutzer'))), modalEl);
  }

  // ---------------- Logs ----------------
  function LogsTab(props) {
    var api = props.api, toast = props.toast;
    var s0 = useState([]), logs = s0[0], setLogs = s0[1];
    var s1 = useState(''), level = s1[0], setLevel = s1[1];
    var sL = useState(true), loading = sL[0], setLoading = sL[1];
    function load(l) { setLoading(true); var q = []; if (l) q.push('level=' + l); api('/admin/logs' + (q.length ? '?' + q.join('&') : '')).then(function (r) { setLogs(Array.isArray(r) ? r : []); }).catch(function (e) { toast(e.message); }).then(function () { setLoading(false); }); }
    useEffect(function () { load(''); }, []);
    function pick(l) { setLevel(l); load(l); }
    function clear() { api('/admin/logs', { method: 'DELETE' }).then(function () { toast('Logs geleert'); load(level); }).catch(function (e) { toast(e.message); }); }
    var levels = [['', 'Alle'], ['info', 'Info'], ['warn', 'Warn'], ['error', 'Error']];
    var rows = logs.map(function (lg, i) {
      var col = lg.level === 'error' ? '#f87171' : (lg.level === 'warn' ? '#fbbf24' : 'var(--ink3)');
      return h('div', { key: i, style: Object.assign({ display: 'flex', gap: '12px', padding: '10px 0', borderBottom: '1px solid var(--chip)', fontSize: '12.5px' }, mono) },
        h('span', { style: { color: 'var(--mut)', flex: '0 0 auto' } }, (lg.created_at || '').toString().replace('T', ' ').slice(0, 19)),
        h('span', { style: { color: col, fontWeight: 700, flex: '0 0 auto', width: '48px' } }, (lg.level || '').toUpperCase()),
        h('span', { style: { flex: '0 0 auto', color: 'var(--ink2)', width: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, lg.action || ''),
        h('span', { style: { color: 'var(--ink)', flex: '1 1 auto', wordBreak: 'break-word' } }, lg.message || ''));
    });
    return h('div', null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' } },
        levels.map(function (x) { return h('div', { key: x[0], onClick: function () { pick(x[0]); }, style: chip(level === x[0]) }, x[1]); }),
        h('div', { style: { flex: 1 } }), h('div', { onClick: clear, style: btnDanger }, 'Logs leeren')),
      h('div', { style: Object.assign({}, box, { padding: '6px 20px' }) },
        loading ? skRows(9, ['48px', '120px']) : (rows.length ? rows : empty('Keine Logs'))));
  }

  // ---------------- Lebensmittel ----------------
  function FoodsTab(props) {
    var api = props.api, toast = props.toast;
    var s0 = useState(''), q = s0[0], setQ = s0[1];
    var s1 = useState([]), foods = s1[0], setFoods = s1[1];
    var s2 = useState(0), total = s2[0], setTotal = s2[1];
    var s3 = useState(true), loading = s3[0], setLoading = s3[1];
    function load(query) {
      setLoading(true);
      api('/admin/foods' + (query ? '?q=' + encodeURIComponent(query) : ''))
        .then(function (r) { setFoods((r && r.foods) || []); setTotal((r && r.total) || 0); })
        .catch(function (e) { toast(e.message); }).then(function () { setLoading(false); });
    }
    useEffect(function () { load(''); }, []);
    var deb = useDebounced(load, 350);
    function onQ(e) { var v = e.target.value; setQ(v); setLoading(true); deb(v.trim()); }
    function del(id) { api('/admin/foods/' + id, { method: 'DELETE' }).then(function () { toast('Gelöscht'); load(q.trim()); }).catch(function (e) { toast(e.message); }); }
    var rows = foods.map(function (f) {
      return h('div', { key: f.id, style: { display: 'flex', alignItems: 'center', gap: '14px', padding: '12px 0', borderBottom: '1px solid var(--chip)' } },
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, h('div', { style: { fontSize: '14px', fontWeight: 600 } }, f.name || '—'), h('div', { style: { fontSize: '11.5px', color: 'var(--ink3)' } }, (f.brand || '') + (f.barcode ? ' · ' + f.barcode : ''))),
        h('div', { style: Object.assign({ fontSize: '12px', color: 'var(--ink3)', flex: '0 0 auto', width: '220px' }, mono) }, Math.round(f.kcal || 0) + ' kcal · K' + (f.carbs || 0) + ' E' + (f.protein || 0) + ' F' + (f.fat || 0)),
        h('div', { onClick: function () { del(f.id); }, style: btnDanger }, 'Löschen'));
    });
    return h('div', null, head('Lebensmittel-Datenbank', loading ? 'Lädt …' : total.toLocaleString('de-DE') + ' Produkte'),
      h('input', { value: q, onChange: onQ, placeholder: 'Suchen (Name, Marke, Barcode) …', style: Object.assign({}, inputStyle, { marginBottom: '14px' }) }),
      h('div', { style: Object.assign({}, box, { padding: '8px 22px' }) },
        loading ? skRows(8, ['220px', '82px']) : (rows.length ? rows : empty('Keine Treffer'))));
  }

  // ---------------- Rezepte: System-Datenbank ----------------
  function RecipeDbView(props) {
    var api = props.api, toast = props.toast;
    var s0 = useState(''), q = s0[0], setQ = s0[1];
    var s1 = useState([]), recipes = s1[0], setRecipes = s1[1];
    var s2 = useState(0), total = s2[0], setTotal = s2[1];
    var s3 = useState(true), loading = s3[0], setLoading = s3[1];
    function load(query) {
      setLoading(true);
      api('/admin/recipes' + (query ? '?q=' + encodeURIComponent(query) : ''))
        .then(function (r) { setRecipes((r && r.recipes) || []); setTotal((r && r.total) || 0); })
        .catch(function (e) { toast(e.message); }).then(function () { setLoading(false); });
    }
    useEffect(function () { load(''); }, []);
    var deb = useDebounced(load, 350);
    function onQ(e) { var v = e.target.value; setQ(v); deb(v.trim()); }
    function del(id) { api('/admin/recipes/' + id, { method: 'DELETE' }).then(function () { toast('Rezept gelöscht'); load(q.trim()); }).catch(function (e) { toast(e.message); }); }
    var rows = recipes.map(function (r) {
      return h('div', { key: r.id, style: { display: 'flex', alignItems: 'center', gap: '14px', padding: '12px 0', borderBottom: '1px solid var(--chip)' } },
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, h('div', { style: { fontSize: '14px', fontWeight: 600 } }, r.name || '—'), h('div', { style: { fontSize: '11.5px', color: 'var(--ink3)' } }, [r.meal, (r.time_min ? r.time_min + ' min' : ''), (r.servings ? r.servings + ' Port.' : ''), r.tags].filter(Boolean).join(' · '))),
        h('div', { style: Object.assign({ fontSize: '12px', color: 'var(--ink3)', flex: '0 0 auto', width: '200px' }, mono) }, Math.round(r.kcal || 0) + ' kcal · K' + (r.carbs || 0) + ' E' + (r.protein || 0) + ' F' + (r.fat || 0)),
        h('div', { onClick: function () { del(r.id); }, style: btnDanger }, 'Löschen'));
    });
    return h('div', null,
      h('div', { style: { fontSize: '13px', color: 'var(--ink3)', marginBottom: '14px' } }, loading ? 'Lädt …' : total.toLocaleString('de-DE') + ' Rezepte'),
      h('input', { value: q, onChange: onQ, placeholder: 'Rezept suchen …', style: Object.assign({}, inputStyle, { marginBottom: '14px' }) }),
      h('div', { style: Object.assign({}, box, { padding: '8px 22px' }) },
        loading ? skRows(6, ['200px', '82px']) : (rows.length ? rows : empty('Keine Treffer'))));
  }

  // ---------------- Rezepte: Freigaben ----------------
  var FLAG_LOOK = {
    slur: { c: '#f87171', t: 'Beleidigung/Slur' },
    hard: { c: '#f87171', t: 'Fäkal-/Sexualsprache' },
    soft: { c: '#fbbf24', t: 'Grenzwertig' },
  };
  var VIEWS_UR = [{ id: 'pending', label: 'Offen' }, { id: 'approved', label: 'Freigegeben' }, { id: 'rejected', label: 'Abgelehnt' }, { id: 'all', label: 'Alle' }];

  function ReviewView(props) {
    var api = props.api, toast = props.toast;
    var s0 = useState('pending'), view = s0[0], setView = s0[1];
    var s1 = useState([]), list = s1[0], setList = s1[1];
    var s2 = useState(0), pending = s2[0], setPending = s2[1];
    var s3 = useState(true), loading = s3[0], setLoading = s3[1];
    var s4 = useState(null), rej = s4[0], setRej = s4[1];
    var s5 = useState(false), busy = s5[0], setBusy = s5[1];
    var s6 = useState(null), check = s6[0], setCheck = s6[1];
    var s7 = useState(false), checking = s7[0], setChecking = s7[1];
    function load(v) {
      setLoading(true);
      api('/admin/user-recipes?view=' + v).then(function (r) { setList((r && r.recipes) || []); setPending((r && r.pending) || 0); })
        .catch(function (e) { toast(e.message); }).then(function () { setLoading(false); });
    }
    useEffect(function () { setCheck(null); load(view); }, [view]);
    function checkup() {
      setChecking(true); setCheck(null);
      api('/admin/user-recipes/checkup', { method: 'POST', body: {} })
        .then(function (r) { setCheck(r); toast(r.flagged.length ? r.flagged.length + ' auffällige Rezepte' : 'Nichts Auffälliges bei ' + r.checked + ' Rezepten'); })
        .catch(function (e) { toast(e.message); }).then(function () { setChecking(false); });
    }
    function review(id, approve, reason) {
      setBusy(true);
      api('/admin/user-recipes/' + id + '/review', { method: 'POST', body: { approve: approve, reason: reason || '' } })
        .then(function () { toast(approve ? 'Rezept freigegeben' : 'Rezept abgelehnt'); setRej(null); setCheck(null); load(view); })
        .catch(function (e) { toast(e.message); }).then(function () { setBusy(false); });
    }
    var cards = list.map(function (r) {
      var fl = FLAG_LOOK[r.flag.worst];
      var st = r.status === 'approved' ? { c: '#34d399', t: 'Freigegeben' } : r.status === 'rejected' ? { c: '#f87171', t: 'Abgelehnt' } : { c: '#fbbf24', t: 'Wartet' };
      return h('div', { key: r.id, style: Object.assign({}, box, { padding: '18px', marginBottom: '12px', borderColor: fl ? 'rgba(248,113,113,.35)' : 'var(--cardbd)' }) },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '12px' } },
          h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
              h('span', { style: { fontSize: '15px', fontWeight: 700 } }, r.name),
              h('span', { style: { fontSize: '10.5px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px', color: st.c, background: 'var(--chip)' } }, st.t),
              fl ? h('span', { style: { fontSize: '10.5px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px', color: fl.c, background: 'rgba(248,113,113,.12)' } }, '⚠ ' + fl.t) : null,
              !r.is_public ? h('span', { style: { fontSize: '10.5px', fontWeight: 600, padding: '3px 8px', borderRadius: '6px', color: 'var(--ink3)', background: 'var(--chip)' } }, 'privat') : null),
            h('div', { style: { fontSize: '12px', color: 'var(--ink3)', marginTop: '5px' } },
              'von ' + r.author + ' · ' + r.meal + (r.time_min ? ' · ' + r.time_min + ' min' : '') + ' · ' + Math.round(r.kcal || 0) + ' kcal')),
          r.status === 'pending' && r.is_public ? h('div', { style: { display: 'flex', gap: '8px', flex: '0 0 auto' } },
            h('div', { onClick: function () { if (!busy) review(r.id, true); }, style: Object.assign({}, btnPrimary, { opacity: busy ? .5 : 1 }) }, 'Freigeben'),
            h('div', { onClick: function () { if (!busy) setRej({ id: r.id, name: r.name, reason: '' }); }, style: btnDanger }, 'Ablehnen')) : null),
        fl ? h('div', { style: { marginTop: '10px', fontSize: '12px', color: '#f87171' } }, 'Gefunden: ' + r.flag.hits.map(function (x) { return x.word; }).join(', ')) : null,
        r.reject_reason ? h('div', { style: { marginTop: '10px', fontSize: '12px', color: 'var(--ink3)' } }, 'Ablehnungsgrund: ' + r.reject_reason) : null,
        h('div', { style: { marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--chip)', fontSize: '12.5px', color: 'var(--ink2)' } },
          h('div', { style: { marginBottom: '6px' } }, h('b', null, 'Zutaten: '), r.ingredients.map(function (i) { return i.name + ' (' + i.amount_g + ' g)'; }).join(', ') || '—'),
          h('div', null, h('b', null, 'Schritte: '), r.steps.length ? r.steps.join(' → ') : '—')));
    });
    return h('div', null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' } },
        VIEWS_UR.map(function (v) {
          return h('div', { key: v.id, onClick: function () { setView(v.id); }, style: chip(view === v.id) },
            v.label, v.id === 'pending' && pending ? h('span', { style: { fontSize: '10.5px', fontWeight: 800, padding: '1px 6px', borderRadius: '99px', background: view === 'pending' ? 'rgba(0,0,0,.18)' : 'var(--acc)', color: view === 'pending' ? '#0f1117' : '#0f1117' } }, String(pending)) : null);
        }),
        h('div', { style: { flex: '1 1 auto' } }),
        h('div', { onClick: function () { if (!checking) checkup(); }, style: Object.assign({}, btnGhost, { opacity: checking ? .5 : 1 }) }, checking ? 'Prüfe …' : '🔍 Auf Troll-Rezepte prüfen')),
      check ? h('div', { style: Object.assign({}, box, { padding: '14px 18px', marginBottom: '12px', borderColor: check.flagged.length ? 'rgba(248,113,113,.35)' : 'rgba(52,211,153,.3)' }) },
        h('div', { style: { fontSize: '13px', fontWeight: 700, color: check.flagged.length ? '#f87171' : '#34d399' } },
          check.flagged.length ? check.flagged.length + ' von ' + check.checked + ' offenen Rezepten auffällig' : check.checked + ' offene Rezepte geprüft, alles sauber'),
        check.flagged.length ? h('div', { style: { fontSize: '12px', color: 'var(--ink2)', marginTop: '6px' } },
          check.flagged.map(function (f) { return f.name + ' (' + f.author + '): ' + f.hits.join(', '); }).join(' · ')) : null) : null,
      loading ? h('div', { style: Object.assign({}, box, { padding: '8px 22px' }) }, skRows(3, ['160px']))
        : (cards.length ? cards : empty(view === 'pending' ? 'Nichts zu prüfen, alles freigegeben.' : 'Keine Rezepte in dieser Ansicht.')),
      rej ? h(Modal, { title: 'Rezept ablehnen', onClose: function () { setRej(null); } },
        h('div', { style: { fontSize: '13px', color: 'var(--ink2)', marginBottom: '14px' } }, '„' + rej.name + '" wird abgelehnt und bleibt privat. Der Grund wird dem Nutzer als Nachricht angezeigt.'),
        h('span', { style: lbl }, 'Grund (Pflicht)'),
        h('textarea', {
          value: rej.reason, onChange: function (e) { var v = e.target.value; setRej(function (x) { return Object.assign({}, x, { reason: v }); }); },
          placeholder: 'z.B. Unpassender Name, Zutaten ergeben kein Gericht …', rows: 3,
          style: Object.assign({}, inputStyle, { resize: 'vertical', fontFamily: "'Space Grotesk',sans-serif" })
        }),
        h('div', { style: { display: 'flex', gap: '10px', marginTop: '18px', justifyContent: 'flex-end' } },
          h('div', { onClick: function () { setRej(null); }, style: btnGhost }, 'Abbrechen'),
          h('div', {
            onClick: function () { if (busy) return; if (!rej.reason.trim()) { toast('Bitte gib einen Grund an'); return; } review(rej.id, false, rej.reason.trim()); },
            style: Object.assign({}, btnPrimary, { background: '#f87171', color: '#fff', opacity: busy ? .5 : 1 })
          }, busy ? 'Lehnt ab …' : 'Ablehnen'))) : null);
  }

  function RecipesTab(props) {
    var s0 = useState('db'), seg = s0[0], setSeg = s0[1];
    var s1 = useState(0), pend = s1[0], setPend = s1[1];
    useEffect(function () { props.api('/admin/user-recipes?view=pending').then(function (r) { setPend((r && r.pending) || 0); }).catch(function () {}); }, [seg]);
    return h('div', null,
      head('Rezepte', seg === 'db' ? 'Die kuratierte Rezept-Datenbank der App' : 'Von Nutzern geteilte Rezepte prüfen und freigeben'),
      h('div', { style: { display: 'flex', gap: '8px', marginBottom: '18px' } },
        h('div', { onClick: function () { setSeg('db'); }, style: chip(seg === 'db') }, 'Datenbank'),
        h('div', { onClick: function () { setSeg('review'); }, style: chip(seg === 'review') }, 'Freigaben',
          pend ? h('span', { style: { fontSize: '10.5px', fontWeight: 800, padding: '1px 6px', borderRadius: '99px', background: seg === 'review' ? 'rgba(0,0,0,.18)' : 'var(--acc)', color: '#0f1117' } }, String(pend)) : null)),
      seg === 'db' ? h(RecipeDbView, props) : h(ReviewView, props));
  }

  // ---------------- Tickets ----------------
  function TicketsTab(props) {
    var api = props.api, toast = props.toast;
    var s0 = useState([]), list = s0[0], setList = s0[1];
    var s1 = useState(''), filter = s1[0], setFilter = s1[1];
    var s2 = useState(null), open = s2[0], setOpen = s2[1];
    var s3 = useState(''), reply = s3[0], setReply = s3[1];
    var sL = useState(true), loading = sL[0], setLoading = sL[1];
    function load(f) { setLoading(true); var q = f ? '?status=' + f : ''; api('/admin/tickets' + q).then(function (t) { setList(Array.isArray(t) ? t : []); }).catch(function (e) { toast(e.message); }).then(function () { setLoading(false); }); }
    useEffect(function () { load(''); }, []);
    function pick(f) { setFilter(f); load(f); }
    function openT(id) { api('/admin/tickets/' + id).then(function (d) { setOpen(d); }).catch(function (e) { toast(e.message); }); }
    function send() { if (!open || !reply.trim()) return; var id = open.id || open.ticket && open.ticket.id; api('/admin/tickets/' + id + '/reply', { method: 'POST', body: { text: reply.trim() } }).then(function () { setReply(''); return api('/admin/tickets/' + id); }).then(function (d) { setOpen(d); load(filter); }).catch(function (e) { toast(e.message); }); }
    function setStatus(st) { var id = open.id || open.ticket && open.ticket.id; api('/admin/tickets/' + id + '/status', { method: 'POST', body: { status: st } }).then(function () { return api('/admin/tickets/' + id); }).then(function (d) { setOpen(d); load(filter); }).catch(function (e) { toast(e.message); }); }
    if (open) {
      var msgs = open.messages || open.msgs || [];
      return h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' } },
          h('div', { onClick: function () { setOpen(null); load(filter); }, style: btnGhost }, '← Zurück'),
          h('div', { style: { flex: 1 } }, h('div', { style: { fontSize: '15px', fontWeight: 700 } }, open.subject || (open.ticket && open.ticket.subject) || 'Ticket'), h('div', { style: { fontSize: '12px', color: 'var(--ink3)' } }, '#' + (open.id || '') + ' · ' + (open.user || open.name || ''))),
          ['offen', 'in_arbeit', 'geschlossen'].map(function (st) { return h('div', { key: st, onClick: function () { setStatus(st); }, style: chip((open.status || '') === st) }, st.replace('_', ' ')); })),
        h('div', { style: Object.assign({}, box, { padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '52vh', overflow: 'auto' }) },
          msgs.length ? msgs.map(function (m, i) { var mine = (m.sender === 'support' || m.admin || m.is_support); return h('div', { key: i, style: { display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' } }, h('div', { style: { maxWidth: '78%', background: mine ? 'var(--acc)' : 'var(--chip)', color: mine ? '#0f1117' : 'var(--ink)', borderRadius: '12px', padding: '10px 14px', fontSize: '13px', whiteSpace: 'pre-wrap' } }, h('div', { style: { fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', opacity: .7, marginBottom: '3px' } }, m.sender || (mine ? 'Support' : 'Nutzer')), m.text || m.message || '')); }) : empty('Keine Nachrichten')),
        h('div', { style: { display: 'flex', gap: '10px', marginTop: '12px' } },
          h('input', { value: reply, onChange: function (e) { setReply(e.target.value); }, placeholder: 'Als Support antworten …', style: inputStyle }),
          h('div', { onClick: send, style: btnPrimary }, 'Senden')));
    }
    var filters = [['', 'Alle'], ['offen', 'Offen'], ['in_arbeit', 'In Arbeit'], ['geschlossen', 'Geschlossen']];
    var rows = list.map(function (t) {
      return h('div', { key: t.id, onClick: function () { openT(t.id); }, style: { display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px', borderRadius: '13px', background: 'var(--panel)', border: '1px solid var(--cardbd)', cursor: 'pointer', marginBottom: '9px', boxShadow: 'var(--cardsh)' } },
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, h('div', { style: { fontSize: '14px', fontWeight: 600 } }, t.subject || '—'), h('div', { style: { fontSize: '11.5px', color: 'var(--ink3)' } }, '#' + t.id + ' · ' + (t.user || t.name || ''))),
        h('span', { style: { fontSize: '10.5px', fontWeight: 700, padding: '5px 11px', borderRadius: '8px', background: 'var(--chip)', color: 'var(--ink2)' } }, t.status || t.statusLabel || ''));
    });
    return h('div', null,
      h('div', { style: { display: 'flex', gap: '7px', marginBottom: '16px', flexWrap: 'wrap' } }, filters.map(function (x) { return h('div', { key: x[0], onClick: function () { pick(x[0]); }, style: chip(filter === x[0]) }, x[1]); })),
      loading ? h('div', { style: Object.assign({}, box, { padding: '8px 22px' }) }, skRows(4, ['80px']))
        : (rows.length ? rows : empty('Keine Tickets')));
  }

  // ---------------- Konversationen (Bot-Sessions) ----------------
  function ConvTab(props) {
    var api = props.api, toast = props.toast;
    var s0 = useState([]), sessions = s0[0], setSessions = s0[1];
    var s1 = useState(null), open = s1[0], setOpen = s1[1];
    var sL = useState(true), loading = sL[0], setLoading = sL[1];
    function load() { setLoading(true); api('/admin/bot-sessions').then(function (r) { setSessions(Array.isArray(r) ? r : []); }).catch(function (e) { toast(e.message); }).then(function () { setLoading(false); }); }
    useEffect(function () { load(); }, []);
    function openS(sid) { api('/admin/bot-sessions/' + encodeURIComponent(sid)).then(function (d) { setOpen({ sid: sid, msgs: Array.isArray(d) ? d : (d && d.messages) || [] }); }).catch(function (e) { toast(e.message); }); }
    if (open) {
      return h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' } }, h('div', { onClick: function () { setOpen(null); }, style: btnGhost }, '← Zurück'), h('div', { style: { fontSize: '14px', fontWeight: 700 } }, 'Session ' + open.sid)),
        h('div', { style: Object.assign({}, box, { padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '62vh', overflow: 'auto' }) },
          open.msgs.length ? open.msgs.map(function (m, i) { var bot = m.role === 'assistant' || m.role === 'bot' || m.from === 'bot'; return h('div', { key: i, style: { display: 'flex', justifyContent: bot ? 'flex-start' : 'flex-end' } }, h('div', { style: { maxWidth: '78%', background: bot ? 'var(--chip)' : 'var(--acc)', color: bot ? 'var(--ink)' : '#0f1117', borderRadius: '12px', padding: '10px 14px', fontSize: '13px', whiteSpace: 'pre-wrap' } }, m.content || m.text || m.message || '')); }) : empty('Keine Nachrichten')));
    }
    var rows = sessions.map(function (se, i) {
      var sid = se.id || se.sid || se.session_id;
      return h('div', { key: i, onClick: function () { openS(sid); }, style: { display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px', borderRadius: '13px', background: 'var(--panel)', border: '1px solid var(--cardbd)', cursor: 'pointer', marginBottom: '9px' } },
        h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { style: { fontSize: '14px', fontWeight: 600 } }, se.title || se.name || ('Session ' + sid)), h('div', { style: { fontSize: '11.5px', color: 'var(--ink3)' } }, (se.user || se.name || '') + (se.updated_at ? ' · ' + String(se.updated_at).slice(0, 19).replace('T', ' ') : ''))));
    });
    return h('div', null, head('Bot-Konversationen', loading ? 'Lädt …' : sessions.length + ' Sessions'),
      loading ? h('div', { style: Object.assign({}, box, { padding: '8px 22px' }) }, skRows(4, []))
        : (rows.length ? rows : empty('Keine Konversationen')));
  }

  // ---------------- Board (Kanban, Lese/Basis) ----------------
  function BoardTab(props) {
    var api = props.api, toast = props.toast;
    var s0 = useState({ lists: [], cards: [] }), data = s0[0], setData = s0[1];
    var sL = useState(true), loading = sL[0], setLoading = sL[1];
    function load() { setLoading(true); return api('/board').then(function (b) { setData({ lists: (b && b.lists) || [], cards: (b && b.cards) || [] }); }).catch(function (e) { toast(e.message); }).then(function () { setLoading(false); }); }
    useEffect(function () { load(); }, []);
    function addList() { var name = window.prompt ? window.prompt('Name der Liste?') : ''; if (!name) return; api('/board/lists', { method: 'POST', body: { name: name } }).then(load).catch(function (e) { toast(e.message); }); }
    function addCard(listId) { var title = window.prompt ? window.prompt('Kartentitel?') : ''; if (!title) return; api('/board/cards', { method: 'POST', body: { list_id: listId, title: title } }).then(load).catch(function (e) { toast(e.message); }); }
    var cols = data.lists.map(function (l) {
      var cards = data.cards.filter(function (c) { return c.list_id === l.id; });
      return h('div', { key: l.id, style: { flex: '0 0 260px', background: 'var(--bg2)', border: '1px solid var(--line3)', borderRadius: '14px', padding: '12px' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' } }, h('div', { style: { fontSize: '13px', fontWeight: 700 } }, l.name), h('div', { style: { fontSize: '11px', color: 'var(--ink3)' } }, cards.length)),
        cards.map(function (c) { return h('div', { key: c.id, style: Object.assign({}, box, { padding: '10px 12px', marginBottom: '8px', fontSize: '13px' }) }, c.title); }),
        h('div', { onClick: function () { addCard(l.id); }, style: { fontSize: '12.5px', color: 'var(--ink3)', cursor: 'pointer', padding: '6px 4px' } }, '+ Karte'));
    });
    return h('div', null,
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' } }, head('Board', loading ? 'Lädt …' : data.lists.length + ' Listen · ' + data.cards.length + ' Karten'), h('div', { onClick: addList, style: btnPrimary }, '+ Liste')),
      h('div', { style: { display: 'flex', gap: '14px', overflowX: 'auto', paddingBottom: '8px', alignItems: 'flex-start' } },
        loading ? [0, 1, 2].map(function (i) { return h('div', { key: i, style: { flex: '0 0 260px', background: 'var(--bg2)', border: '1px solid var(--line3)', borderRadius: '14px', padding: '12px' } }, skBar('50%', 13), h('div', { style: { height: '12px' } }), skBar('100%', 42), h('div', { style: { height: '8px' } }), skBar('100%', 42)); })
          : (cols.length ? cols : empty('Kein Board'))));
  }

  // ---------------- Haupt-Komponente ----------------
  var VIEWS = { users: UsersTab, logs: LogsTab, foods: FoodsTab, recipes: RecipesTab, tickets: TicketsTab, conv: ConvTab, board: BoardTab };
  function AdminPanel(props) {
    var api = props.api, toast = props.toast || function () {};
    var tb = useState('users'), tab = tb[0], setTab = tb[1];
    if (!api) return h('div', { style: { padding: '40px', color: 'var(--ink3)' } }, 'Admin: keine API-Verbindung');
    var View = VIEWS[tab] || UsersTab;
    return h('div', null,
      h('div', { style: { position: 'sticky', top: 0, zIndex: 20, background: 'var(--bg)', borderBottom: '1px solid var(--chip)' } },
        h('div', { style: { maxWidth: '1340px', margin: '0 auto', padding: '12px 30px', display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' } },
          TABS.map(function (t) { return h('div', { key: t.id, onClick: function () { setTab(t.id); }, style: chip(tab === t.id) }, t.label); }))),
      h('div', { style: { padding: '26px 30px 44px', maxWidth: '1340px', margin: '0 auto' } }, h(View, { key: tab, api: api, toast: toast })));
  }
  window.AdminPanel = AdminPanel;
})();
