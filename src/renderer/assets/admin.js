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
    function load() { api('/admin/users').then(function (u) { setUsers(Array.isArray(u) ? u : []); }).catch(function (e) { toast(e.message); }); }
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
        head('Nutzerverwaltung', users.length + ' Konten · anlegen, bearbeiten & Passwörter setzen'),
        h('div', { onClick: openNew, style: btnPrimary }, '+ Nutzer anlegen')),
      h('div', { style: Object.assign({}, box, { padding: '8px 22px' }) }, rows.length ? rows : empty('Keine Nutzer')), modalEl);
  }

  // ---------------- Logs ----------------
  function LogsTab(props) {
    var api = props.api, toast = props.toast;
    var s0 = useState([]), logs = s0[0], setLogs = s0[1];
    var s1 = useState(''), level = s1[0], setLevel = s1[1];
    function load(l) { var q = []; if (l) q.push('level=' + l); api('/admin/logs' + (q.length ? '?' + q.join('&') : '')).then(function (r) { setLogs(Array.isArray(r) ? r : []); }).catch(function (e) { toast(e.message); }); }
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
      h('div', { style: Object.assign({}, box, { padding: '6px 20px' }) }, rows.length ? rows : empty('Keine Logs')));
  }

  // ---------------- Lebensmittel ----------------
  function FoodsTab(props) {
    var api = props.api, toast = props.toast;
    var s0 = useState(''), q = s0[0], setQ = s0[1];
    var s1 = useState([]), foods = s1[0], setFoods = s1[1];
    var s2 = useState(0), total = s2[0], setTotal = s2[1];
    function load(query) { api('/admin/foods' + (query ? '?q=' + encodeURIComponent(query) : '')).then(function (r) { setFoods((r && r.foods) || []); setTotal((r && r.total) || 0); }).catch(function (e) { toast(e.message); }); }
    useEffect(function () { load(''); }, []);
    var deb = useDebounced(load, 350);
    function onQ(e) { var v = e.target.value; setQ(v); deb(v.trim()); }
    function del(id) { api('/admin/foods/' + id, { method: 'DELETE' }).then(function () { toast('Gelöscht'); load(q.trim()); }).catch(function (e) { toast(e.message); }); }
    var rows = foods.map(function (f) {
      return h('div', { key: f.id, style: { display: 'flex', alignItems: 'center', gap: '14px', padding: '12px 0', borderBottom: '1px solid var(--chip)' } },
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, h('div', { style: { fontSize: '14px', fontWeight: 600 } }, f.name || '—'), h('div', { style: { fontSize: '11.5px', color: 'var(--ink3)' } }, (f.brand || '') + (f.barcode ? ' · ' + f.barcode : ''))),
        h('div', { style: Object.assign({ fontSize: '12px', color: 'var(--ink3)', flex: '0 0 auto', width: '220px' }, mono) }, Math.round(f.kcal || 0) + ' kcal · K' + (f.carbs || 0) + ' E' + (f.protein || 0) + ' F' + (f.fat || 0)),
        h('div', { onClick: function () { del(f.id); }, style: btnDanger }, 'Löschen'));
    });
    return h('div', null, head('Lebensmittel-Datenbank', total.toLocaleString('de-DE') + ' Produkte'),
      h('input', { value: q, onChange: onQ, placeholder: 'Suchen (Name, Marke, Barcode) …', style: Object.assign({}, inputStyle, { marginBottom: '14px' }) }),
      h('div', { style: Object.assign({}, box, { padding: '8px 22px' }) }, rows.length ? rows : empty('Keine Treffer')));
  }

  // ---------------- Rezepte ----------------
  function RecipesTab(props) {
    var api = props.api, toast = props.toast;
    var s0 = useState(''), q = s0[0], setQ = s0[1];
    var s1 = useState([]), recipes = s1[0], setRecipes = s1[1];
    var s2 = useState(0), total = s2[0], setTotal = s2[1];
    function load(query) { api('/admin/recipes' + (query ? '?q=' + encodeURIComponent(query) : '')).then(function (r) { setRecipes((r && r.recipes) || []); setTotal((r && r.total) || 0); }).catch(function (e) { toast(e.message); }); }
    useEffect(function () { load(''); }, []);
    var deb = useDebounced(load, 350);
    function onQ(e) { var v = e.target.value; setQ(v); deb(v.trim()); }
    function del(id) { if (!window.confirm) { } api('/admin/recipes/' + id, { method: 'DELETE' }).then(function () { toast('Rezept gelöscht'); load(q.trim()); }).catch(function (e) { toast(e.message); }); }
    var rows = recipes.map(function (r) {
      return h('div', { key: r.id, style: { display: 'flex', alignItems: 'center', gap: '14px', padding: '12px 0', borderBottom: '1px solid var(--chip)' } },
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, h('div', { style: { fontSize: '14px', fontWeight: 600 } }, r.name || '—'), h('div', { style: { fontSize: '11.5px', color: 'var(--ink3)' } }, [r.meal, (r.time_min ? r.time_min + ' min' : ''), (r.servings ? r.servings + ' Port.' : ''), r.tags].filter(Boolean).join(' · '))),
        h('div', { style: Object.assign({ fontSize: '12px', color: 'var(--ink3)', flex: '0 0 auto', width: '200px' }, mono) }, Math.round(r.kcal || 0) + ' kcal · K' + (r.carbs || 0) + ' E' + (r.protein || 0) + ' F' + (r.fat || 0)),
        h('div', { onClick: function () { del(r.id); }, style: btnDanger }, 'Löschen'));
    });
    return h('div', null, head('Rezept-Datenbank', total.toLocaleString('de-DE') + ' Rezepte'),
      h('input', { value: q, onChange: onQ, placeholder: 'Rezept suchen …', style: Object.assign({}, inputStyle, { marginBottom: '14px' }) }),
      h('div', { style: Object.assign({}, box, { padding: '8px 22px' }) }, rows.length ? rows : empty('Keine Treffer')));
  }

  // ---------------- Tickets ----------------
  function TicketsTab(props) {
    var api = props.api, toast = props.toast;
    var s0 = useState([]), list = s0[0], setList = s0[1];
    var s1 = useState(''), filter = s1[0], setFilter = s1[1];
    var s2 = useState(null), open = s2[0], setOpen = s2[1];
    var s3 = useState(''), reply = s3[0], setReply = s3[1];
    function load(f) { var q = f ? '?status=' + f : ''; api('/admin/tickets' + q).then(function (t) { setList(Array.isArray(t) ? t : []); }).catch(function (e) { toast(e.message); }); }
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
      rows.length ? rows : empty('Keine Tickets'));
  }

  // ---------------- Konversationen (Bot-Sessions) ----------------
  function ConvTab(props) {
    var api = props.api, toast = props.toast;
    var s0 = useState([]), sessions = s0[0], setSessions = s0[1];
    var s1 = useState(null), open = s1[0], setOpen = s1[1];
    function load() { api('/admin/bot-sessions').then(function (r) { setSessions(Array.isArray(r) ? r : []); }).catch(function (e) { toast(e.message); }); }
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
    return h('div', null, head('Bot-Konversationen', sessions.length + ' Sessions'), rows.length ? rows : empty('Keine Konversationen'));
  }

  // ---------------- Board (Kanban, Lese/Basis) ----------------
  function BoardTab(props) {
    var api = props.api, toast = props.toast;
    var s0 = useState({ lists: [], cards: [] }), data = s0[0], setData = s0[1];
    function load() { api('/board').then(function (b) { setData({ lists: (b && b.lists) || [], cards: (b && b.cards) || [] }); }).catch(function (e) { toast(e.message); }); }
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
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' } }, head('Board', data.lists.length + ' Listen · ' + data.cards.length + ' Karten'), h('div', { onClick: addList, style: btnPrimary }, '+ Liste')),
      h('div', { style: { display: 'flex', gap: '14px', overflowX: 'auto', paddingBottom: '8px', alignItems: 'flex-start' } }, cols.length ? cols : empty('Kein Board')));
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
