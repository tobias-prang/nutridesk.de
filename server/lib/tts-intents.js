'use strict';
// SEC-003: Zentrale Zuordnung Intent -> serverseitige TTS-Metadaten (Datenherkunft).
// KNOWN_INTENTS = alle von route() bzw. /bot/chat erzeugbaren Intents; der Vollstaendigkeitstest
// stellt sicher, dass jeder davon Metadaten hat und unbekannte/fehlende -> mindestens SENSITIVE.

const { TTS_POLICY_VERSION } = require('./tts-policy');

const PUBLIC_INTENTS = ['smalltalk', 'greet', 'confirm', 'cancel', 'unknown'];

const KNOWN_INTENTS = [
  ...PUBLIC_INTENTS,
  'food_info', 'help', 'wiki', 'weather', 'data',
  'flow', 'flow_confirm',
  'action_done:transaction', 'action_done:todo', 'action_done:weight',
  'action_done:appointment', 'action_done:food', 'action_done:ticket',
];

function ttsMetaFor(intent) {
  const i = String(intent || '');
  const meta = (o) => Object.assign({ policyVersion: TTS_POLICY_VERSION }, o);
  if (PUBLIC_INTENTS.includes(i)) return meta({ sources: ['static'] });
  if (i === 'food_info') return meta({ sources: ['food_db'] });
  if (i === 'help') return meta({ sources: ['help'] });
  if (i === 'wiki') return meta({ sources: ['wiki'] });
  if (i === 'weather') return meta({ sources: ['weather', 'location'] });
  if (i === 'data') return meta({ sources: ['user_data'], containsUserText: true });
  // flow, flow_confirm, action_done:* und alles Uebrige/Unbekannte -> Nutzeraktion/-daten (SENSITIVE)
  return meta({ sources: ['user_action'], containsUserText: true, containsPrivateFreeText: true });
}

module.exports = { PUBLIC_INTENTS, KNOWN_INTENTS, ttsMetaFor };
