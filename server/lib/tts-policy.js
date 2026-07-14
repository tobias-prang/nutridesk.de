'use strict';
// SEC-003: Zentrale, serverseitige TTS-Datenschutz-Policy. Reine, testbare Funktionen.
// Klassen (aufsteigende Schutzstufe): PUBLIC < PRIVATE < SENSITIVE < STRICTLY_SENSITIVE.

// ZWEI klar getrennte Versionen (nicht verwechseln):
// - TTS_POLICY_VERSION: Version des Klassifizierungs-/Metadaten-Schemas. Steht in bot_chat.tts_meta.policyVersion,
//   validiert gespeicherte Klassifizierungs-Metadaten; fehlt/unbekannt -> Fallback mind. SENSITIVE.
// - TTS_PRIVACY_NOTICE_VERSION: Version des Cloud-TTS-Datenschutzhinweises. Steht in user_settings.cloud_tts_privacy_version,
//   prueft, ob der Nutzer der aktuell angezeigten Datenschutzinformation zugestimmt/aktiviert hat. Aendert sich bei
//   wesentlicher Aenderung von Anbieter/Uebertragung/Aufbewahrung/Hinweis -> erneutes Opt-in noetig.
const TTS_POLICY_VERSION = '1';
const TTS_PRIVACY_NOTICE_VERSION = '1';
const CLOUD_TTS_PROVIDERS = ['elevenlabs']; // Provider-Allowlist. Nichts anderes (kein edge/microsoft/...).

const RANK = { PUBLIC: 0, PRIVATE: 1, SENSITIVE: 2, STRICTLY_SENSITIVE: 3 };
const NAME = ['PUBLIC', 'PRIVATE', 'SENSITIVE', 'STRICTLY_SENSITIVE'];

const SOURCE_CLASS = {
  static: 'PUBLIC', food_db: 'PUBLIC', help: 'PUBLIC', wiki: 'PUBLIC',
  weather: 'PRIVATE', location: 'PRIVATE', todo_count: 'PRIVATE', name: 'PRIVATE', email: 'PRIVATE',
  bank_balance: 'SENSITIVE', transaction_description: 'SENSITIVE', weight: 'SENSITIVE', calories: 'SENSITIVE',
  appointment_title: 'SENSITIVE', todo_text: 'SENSITIVE', support_ticket_subject: 'SENSITIVE',
  user_data: 'SENSITIVE', user_action: 'SENSITIVE',
  private_note: 'STRICTLY_SENSITIVE', document_content: 'STRICTLY_SENSITIVE',
  bank_pin: 'STRICTLY_SENSITIVE', tan: 'STRICTLY_SENSITIVE', password: 'STRICTLY_SENSITIVE',
  token: 'STRICTLY_SENSITIVE', api_key: 'STRICTLY_SENSITIVE',
};

// Harte Inhaltssperre (Defense-in-Depth). Trifft einer -> STRICTLY_SENSITIVE, nie irgendein Provider.
function scanForbiddenTtsContent(text) {
  const t = String(text || '');
  const hits = [];
  if (/\b(pin|geheimzahl)\b/i.test(t) && /\d{3,}/.test(t)) hits.push('pin');
  if (/\btan\b/i.test(t) && /\d{4,}/.test(t)) hits.push('tan');
  if (/\b(passwor?t|password)\b/i.test(t) && /[:=]?\s*\S{4,}/.test(t)) hits.push('password');
  if (/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|bearer)\b/i.test(t) || /\bsk_[A-Za-z0-9_]{10,}\b/.test(t) || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(t)) hits.push('token');
  if (/\b[A-Z]{2}\d{2}(?:[ ]?\d){12,30}\b/.test(t)) hits.push('iban');
  if (/(?:\d[ -]?){13,19}(?!\d)/.test(t)) hits.push('card_or_account');
  return { blocked: hits.length > 0, hits };
}

// Endgueltige Klasse aus serverseitigen Metadaten (Datenherkunft) + harter Inhaltspruefung.
function classifyTtsContent(responseMetadata, text) {
  const meta = responseMetadata || {};
  let rank = 0;
  const srcs = Array.isArray(meta.sources) ? meta.sources : [];
  for (const s of srcs) { const c = SOURCE_CLASS[s]; if (c) rank = Math.max(rank, RANK[c]); }
  if (meta.containsFinancialData || meta.containsHealthData || meta.containsUserText || meta.containsPrivateFreeText) rank = Math.max(rank, RANK.SENSITIVE);
  if (!srcs.length || !srcs.some((s) => SOURCE_CLASS[s])) rank = Math.max(rank, RANK.SENSITIVE);
  // Fehlende/veraltete/unbekannte Metadaten-Schemaversion -> Metadaten nicht vertrauen, mind. SENSITIVE.
  if (String(meta.policyVersion || '') !== TTS_POLICY_VERSION) rank = Math.max(rank, RANK.SENSITIVE);
  const forbidden = scanForbiddenTtsContent(text);
  if (forbidden.blocked) rank = RANK.STRICTLY_SENSITIVE;
  return { classification: NAME[rank], forbidden: forbidden.blocked, forbiddenHits: forbidden.hits, policyVersion: TTS_POLICY_VERSION };
}

function redactTtsContent(text) {
  let s = String(text || '');
  let applied = false;
  const rep = (re, val) => { if (re.test(s)) { s = s.replace(re, val); applied = true; } };
  rep(/\b[A-Z]{2}\d{2}(?:[ ]?\d){10,30}\b/g, 'eine IBAN');
  rep(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, 'eine E-Mail-Adresse');
  rep(/(?:\d[ -]?){13,19}(?!\d)/g, 'eine Nummer');
  rep(/\+?\d[\d /()-]{8,15}\d/g, 'eine Telefonnummer');
  return { text: s, redactionApplied: applied };
}

// Darf der Text ueber Cloud-TTS (ElevenLabs) ausgegeben werden? (nur Nutzer-Ebene; global/version in decideTts)
function isCloudTtsAllowed(userSettings, classification, explicitRequest) {
  if (classification === 'SENSITIVE') return { allowed: false, reason: 'class_sensitive' };
  if (classification === 'STRICTLY_SENSITIVE') return { allowed: false, reason: 'class_strictly_sensitive' };
  const enabled = !!(userSettings && Number(userSettings.cloud_tts_enabled) === 1);
  if (!enabled) return { allowed: false, reason: 'no_opt_in' };
  if (!explicitRequest) return { allowed: false, reason: 'no_explicit_request' };
  return { allowed: true, reason: 'allowed', redact: classification === 'PRIVATE' };
}

// Grundsaetzliche lokale Zulaessigkeit (netzfrei). Ob eine verifiziert lokale Stimme existiert, entscheidet der Renderer (SEC-003B).
function isLocalTtsAllowed(classification, forbidden) {
  if (forbidden) return false;
  return classification !== 'STRICTLY_SENSITIVE';
}

// Zentrale Entscheidung OHNE Provider-Aufruf. action ist 'cloud' oder 'blocked' (+ localEligible).
function decideTts(input) {
  const meta = (input && input.meta) || {};
  const text = (input && input.text) || '';
  const settings = (input && input.settings) || {};
  const explicit = !!(input && input.explicit);
  const cloudAvailable = !!(input && input.cloudAvailable);                 // globale Serversperre (Default aus)
  const currentPrivacyNoticeVersion = input && input.currentPrivacyNoticeVersion; // erzwungene Datenschutzhinweis-Version
  const cls = classifyTtsContent(meta, text);
  let cloud;
  if (!cloudAvailable) {
    cloud = { allowed: false, reason: 'cloud_globally_disabled' };
  } else if (currentPrivacyNoticeVersion != null && String(settings.cloud_tts_privacy_version || '') !== String(currentPrivacyNoticeVersion)) {
    cloud = { allowed: false, reason: 'privacy_notice_version_mismatch' };
  } else {
    cloud = isCloudTtsAllowed(settings, cls.classification, explicit);
  }
  if (cloud.allowed) return { action: 'cloud', classification: cls.classification, redact: !!cloud.redact, reason: cloud.reason, forbidden: cls.forbidden, policyVersion: cls.policyVersion };
  // Nie automatisch "local" behaupten: immer 'blocked' + Flag, ob lokale Ausgabe grundsaetzlich zulaessig waere.
  return { action: 'blocked', localEligible: isLocalTtsAllowed(cls.classification, cls.forbidden), classification: cls.classification, redact: false, reason: cloud.reason, forbidden: cls.forbidden, policyVersion: cls.policyVersion };
}

module.exports = {
  TTS_POLICY_VERSION, TTS_PRIVACY_NOTICE_VERSION, CLOUD_TTS_PROVIDERS,
  classifyTtsContent, scanForbiddenTtsContent, redactTtsContent, isCloudTtsAllowed, isLocalTtsAllowed, decideTts,
};
