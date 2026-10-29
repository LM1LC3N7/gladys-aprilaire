// -----------------------------------------------------------------------------
// Runtime texts (English and French): device, feature and option names, the
// status of the integration, the answers of the button and the command errors.
// -----------------------------------------------------------------------------

import { FEATURES as F, MODELS, SETPOINT_BOUNDS } from './constants.js';

export const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** Texts one after the other, in both languages (empty ones left out). */
export const join = (...parts) => {
  const list = parts.filter(Boolean);
  return both(
    list
      .map((p) => p.en)
      .filter(Boolean)
      .join(' '),
    list
      .map((p) => p.fr)
      .filter(Boolean)
      .join(' '),
  );
};

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return both(`${seconds} s`, `${seconds} s`);
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return both(`${minutes} min`, `${minutes} min`);
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

/** "8840", or "model 99" for a number not in the list. */
export const modelName = (model) =>
  Number.isInteger(model) ? (MODELS[model] ?? `#${model}`) : undefined;

export const DEVICE_NAME = (model) =>
  model === undefined
    ? both('Aprilaire thermostat', 'Thermostat Aprilaire')
    : both(`Aprilaire ${model} thermostat`, `Thermostat Aprilaire ${model}`);

export const FEATURE_NAMES = {
  [F.TEMPERATURE]: both('Temperature', 'Température'),
  [F.HUMIDITY]: both('Humidity', 'Humidité'),
  [F.OUTDOOR]: both('Outdoor temperature', 'Température extérieure'),
  [F.OUTDOOR_HUMIDITY]: both('Outdoor humidity', 'Humidité extérieure'),
  [F.HEAT_SETPOINT]: both('Heating setpoint', 'Consigne de chauffage'),
  [F.COOL_SETPOINT]: both('Cooling setpoint', 'Consigne de climatisation'),
  [F.MODE]: both('Mode', 'Mode'),
  [F.FAN]: both('Fan', 'Ventilateur'),
  [F.FAN_RUNNING]: both('Fan running', 'Ventilateur en marche'),
  [F.OPERATING_STATE]: both('Operating state', 'Fonctionnement'),
  [F.HOLD]: both('Hold', 'Dérogation'),
  [F.HUMIDIFIER]: both('Humidifier', 'Humidificateur'),
  [F.DEHUMIDIFIER]: both('Dehumidifier', 'Déshumidificateur'),
  [F.VENTILATION]: both('Fresh air ventilation', 'Ventilation (air neuf)'),
  [F.AIR_CLEANER]: both('Air cleaner', 'Purificateur d’air'),
  [F.ERROR]: both('Thermostat error', 'Erreur du thermostat'),
};

export const MODE_NAMES = {
  off: both('Off', 'Arrêt'),
  heat: both('Heating', 'Chauffage'),
  cool: both('Cooling', 'Climatisation'),
  auto: both('Auto', 'Auto'),
};

export const FAN_NAMES = {
  auto: both('Auto', 'Auto'),
  on: both('On', 'Marche'),
  circulate: both('Circulate', 'Brassage'),
};

/** spec 3.4 */
export const HOLD_NAMES = [
  both('None (schedule)', 'Aucune (programme)'),
  both('Temporary', 'Temporaire'),
  both('Permanent', 'Permanente'),
  both('Away', 'Absence'),
  both('Vacation', 'Vacances'),
];

const IDLE = both('idle', 'au repos');
const WAIT = both('waiting', 'en attente');
const ON = both('running', 'en marche');
const OFF = both('off', 'arrêté');
const LOCKOUT = both('locked out', 'bloquée');

/** spec 7.7, collapsed as the spec says (idle / wait / on / off). */
export const IAQ_STATUS = {
  dehumidification: [
    IDLE,
    WAIT,
    ON,
    both('running (overcooling)', 'en marche (surrefroidissement)'),
    OFF,
  ],
  humidification: [IDLE, WAIT, ON, OFF],
  ventilation: [
    IDLE,
    WAIT,
    ON,
    join(LOCKOUT, both('(high temperature)', '(température haute)')),
    join(LOCKOUT, both('(low temperature)', '(température basse)')),
    join(LOCKOUT, both('(high humidity)', '(humidité haute)')),
    OFF,
  ],
  airCleaning: [IDLE, WAIT, ON, OFF],
};

/** spec 7.8 */
export const ERROR_NAMES = [
  both('None', 'Aucune'),
  both('E1: built-in temperature sensor open', 'E1 : sonde de température intégrée coupée'),
  both(
    'E2: built-in temperature sensor short',
    'E2 : sonde de température intégrée en court-circuit',
  ),
  both('E3: memory access error', 'E3 : erreur d’accès mémoire'),
  both('E4', 'E4'),
  both('E5: equipment module communication lost', 'E5 : communication perdue avec le module'),
  both('E6: remote temperature sensor open', 'E6 : sonde de température déportée coupée'),
  both(
    'E7: remote temperature sensor short',
    'E7 : sonde de température déportée en court-circuit',
  ),
  both('E8: support module temperature lost', 'E8 : température du module de support perdue'),
];

const percent = (value) => both(`${value} %`, `${value} %`);

/** The humidifier text: its state and setpoint (spec 2.4 / 7.7). */
export function humidifierText(status, setpoint) {
  const parts = [IAQ_STATUS.humidification[status]];
  if (setpoint === 0) parts.push(both('(set to off)', '(réglé sur arrêt)'));
  else if (setpoint >= 1 && setpoint <= 7)
    parts.push(both(`(automatic, level ${setpoint})`, `(automatique, niveau ${setpoint})`));
  else if (setpoint !== undefined)
    parts.push(both(`(setpoint ${percent(setpoint).en})`, `(consigne ${percent(setpoint).fr})`));
  return parts[0] ? capitalize(join(...parts)) : undefined;
}

/** The dehumidifier text: its state and setpoint (spec 2.3 / 7.7). */
export function dehumidifierText(status, setpoint) {
  const parts = [IAQ_STATUS.dehumidification[status]];
  if (setpoint === 0) parts.push(both('(set to off)', '(réglé sur arrêt)'));
  else if (setpoint !== undefined)
    parts.push(both(`(setpoint ${setpoint} %)`, `(consigne ${setpoint} %)`));
  return parts[0] ? capitalize(join(...parts)) : undefined;
}

const FRESH_AIR_MODES = { 0: both('off', 'arrêt'), 1: both('automatic', 'automatique') };
const FRESH_AIR_EVENTS = { 2: both('3 hours', '3 heures'), 3: both('24 hours', '24 heures') };
const CLEANING_MODES = {
  0: both('off', 'arrêt'),
  1: both('constant', 'continu'),
  2: both('automatic', 'automatique'),
};
const CLEANING_EVENTS = {
  3: both('event clean', 'nettoyage ponctuel'),
  4: both('allergies', 'allergies'),
};

/** The ventilation / air cleaner text: state, mode and running event (spec 2.5 / 2.6 / 7.7). */
export function iaqText(kind, status, mode, event) {
  const ventilation = kind === 'ventilation';
  const state = (ventilation ? IAQ_STATUS.ventilation : IAQ_STATUS.airCleaning)[status];
  if (!state) return undefined;
  const m = (ventilation ? FRESH_AIR_MODES : CLEANING_MODES)[mode];
  const e = (ventilation ? FRESH_AIR_EVENTS : CLEANING_EVENTS)[event];
  const tail = (language, label) =>
    m ? ` (mode ${m[language]}${e ? `, ${label} ${e[language]}` : ''})` : '';
  return capitalize(
    both(`${state.en}${tail('en', 'event')}`, `${state.fr}${tail('fr', 'événement')}`),
  );
}

const capitalize = (t) =>
  both(t.en.charAt(0).toUpperCase() + t.en.slice(1), t.fr.charAt(0).toUpperCase() + t.fr.slice(1));

const B = SETPOINT_BOUNDS;

/** The integration status and the answers of the button. */
export const T = {
  noAddress: both(
    'Enter the address of your Aprilaire thermostat (its "Automation" connection turned on at the thermostat), then save.',
    'Saisissez l’adresse de votre thermostat Aprilaire (sa connexion « Automation » activée sur le thermostat), puis enregistrez.',
  ),
  invalid: (typed) =>
    both(
      `Invalid address "${typed}": an IPv4 address or a host name, optionally with a port (7000 by default).`,
      `Adresse invalide « ${typed} » : une adresse IPv4 ou un nom d’hôte, avec un port si besoin (7000 par défaut).`,
    ),
  configUnreadable: (wait) =>
    both(
      `The configuration could not be read from Gladys: tried again in ${wait.en}. A stop kept from before still goes to the thermostat.`,
      `La configuration n’a pas pu être lue depuis Gladys : nouvel essai dans ${wait.fr}. Un arrêt gardé d’avant part quand même vers le thermostat.`,
    ),
  dataUnreadable: both(
    'The memory of the integration in /data cannot be read: it is never overwritten; a stop kept there may not be known.',
    'La mémoire de l’intégration dans /data est illisible : elle n’est jamais écrasée ; un arrêt qui y était gardé peut être inconnu.',
  ),
  connecting: (address) => both(`Connecting to ${address}…`, `Connexion à ${address}…`),
  waiting: (wait) =>
    both(
      `First connection in ${wait.en} (never sooner than the refresh interval after the last one).`,
      `Première connexion dans ${wait.fr} (jamais avant l’intervalle de rafraîchissement après la précédente).`,
    ),
  unreachable: (address, reason, wait) =>
    both(
      `No session with ${address} (${reason}); next try in ${wait.en}. Check the address, that the thermostat's connection type is "Automation", and that nothing else (another home automation system) holds its only connection.`,
      `Pas de session avec ${address} (${reason}) ; nouvel essai dans ${wait.fr}. Vérifiez l’adresse, que le type de connexion du thermostat est « Automation », et que rien d’autre (une autre domotique) ne tient sa connexion unique.`,
    ),
  identifying: both(
    'Connected; the identity of the thermostat (MAC address) is not read yet: nothing shown, no command but the stop.',
    'Connecté ; l’identité du thermostat (adresse MAC) n’est pas encore lue : rien d’affiché, aucune commande sauf l’arrêt.',
  ),
  connected: (model, mac, ago) =>
    both(
      `Connected to the Aprilaire ${model ?? ''} thermostat ${mac}; last read ${ago.en} ago.`.replace(
        '  ',
        ' ',
      ),
      `Connecté au thermostat Aprilaire ${model ?? ''} ${mac} ; dernière lecture il y a ${ago.fr}.`.replace(
        '  ',
        ' ',
      ),
    ),
  connectedNoRead: (model, mac) =>
    both(
      `Connected to the Aprilaire ${model ?? ''} thermostat ${mac}; values not read yet.`.replace(
        '  ',
        ' ',
      ),
      `Connecté au thermostat Aprilaire ${model ?? ''} ${mac} ; valeurs pas encore lues.`.replace(
        '  ',
        ' ',
      ),
    ),
  readFailed: (reason) =>
    both(`The last read failed (${reason}).`, `La dernière lecture a échoué (${reason}).`),
  otherThermostat: (mac) =>
    both(
      `Another thermostat answers at this address (MAC ${mac}): it is a new device in the Discovery tab; the previous one gets no value any more.`,
      `Un autre thermostat répond à cette adresse (MAC ${mac}) : c’est un nouvel appareil dans l’onglet Découverte ; le précédent ne reçoit plus de valeur.`,
    ),
  stopNotSent: both(
    'A stop (mode Off) is kept: not sent yet, it leaves first as soon as the thermostat answers.',
    'Un arrêt (mode Arrêt) est gardé : pas encore envoyé, il part en premier dès que le thermostat répond.',
  ),
  stopUnconfirmed: (count) =>
    both(
      `A stop (mode Off) was sent ${count} time(s) and is not confirmed yet: checked every 15 s, then every minute, and sent again while the thermostat shows the mode of before (3 times at most); the other commands are refused meanwhile.`,
      `Un arrêt (mode Arrêt) a été envoyé ${count} fois et n’est pas encore confirmé : vérifié toutes les 15 s, puis chaque minute, et renvoyé tant que le thermostat montre le mode d’avant (3 fois au plus) ; les autres commandes sont refusées en attendant.`,
    ),
  stopGivenUp: (count) =>
    both(
      `A stop (mode Off) was sent ${count} times and the thermostat still shows the mode of before: not sent again; check the thermostat. The other commands are refused until a read shows Off or a new mode is chosen.`,
      `Un arrêt (mode Arrêt) a été envoyé ${count} fois et le thermostat montre toujours le mode d’avant : il n’est plus renvoyé ; vérifiez le thermostat. Les autres commandes sont refusées jusqu’à ce qu’une lecture montre l’arrêt ou qu’un nouveau mode soit choisi.`,
    ),
  stopRefused: (reason) =>
    both(
      `The thermostat refused the stop (${reason}).`,
      `Le thermostat a refusé l’arrêt (${reason}).`,
    ),
  stopBusy: (reason) =>
    both(
      `A stop (mode Off) is kept: the thermostat answered "busy" (${reason}), not applied; written again at every check (every 15 s, then every minute).`,
      `Un arrêt (mode Arrêt) est gardé : le thermostat a répondu « occupé » (${reason}), non appliqué ; réécrit à chaque vérification (toutes les 15 s, puis chaque minute).`,
    ),
  test: {
    later: (wait) =>
      both(
        `Next connection attempt in ${wait.en} (never sooner than the refresh interval):`,
        `Prochain essai de connexion dans ${wait.fr} (jamais avant l’intervalle de rafraîchissement) :`,
      ),
  },
};

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  badValue: both('Unknown value: not sent.', 'Valeur inconnue : non envoyée.'),
  outOfRange: both(
    `Out of the thermostat's range (${B.min} to ${B.max} °C): not sent.`,
    `Hors de la plage du thermostat (${B.min} à ${B.max} °C) : non envoyée.`,
  ),
  disabled: both(
    'Commands are disabled: turn on "Allow the commands" in the configuration of the integration (the stop, mode Off, never depends on this option).',
    'Les commandes sont désactivées : activez « Autoriser les commandes » dans la configuration de l’intégration (l’arrêt, mode Arrêt, ne dépend jamais de cette option).',
  ),
  unknownDevice: both(
    'This thermostat is not the one connected at the address of the configuration: not sent.',
    'Ce thermostat n’est pas celui connecté à l’adresse de la configuration : non envoyée.',
  ),
  notConnected: both(
    'No session with the thermostat right now (its identity not read): not sent.',
    'Pas de session avec le thermostat en ce moment (son identité n’est pas lue) : non envoyée.',
  ),
  stopHeld: both(
    'A stop (mode Off) is not confirmed yet: only a stop or a new mode is sent meanwhile. Not sent.',
    'Un arrêt (mode Arrêt) n’est pas encore confirmé : seul un arrêt ou un nouveau mode part en attendant. Non envoyée.',
  ),
  modeUnavailable: both(
    'This thermostat does not offer this mode: not sent.',
    'Ce thermostat ne propose pas ce mode : non envoyée.',
  ),
  cancelled: both(
    'A stop was clicked meanwhile: this command was dropped, not sent.',
    'Un arrêt a été cliqué entre-temps : cette commande est abandonnée, non envoyée.',
  ),
  superseded: both(
    'A stop was sent after this command: the stop wins.',
    'Un arrêt a été envoyé après cette commande : l’arrêt l’emporte.',
  ),
  configChanged: both(
    'The configuration changed meanwhile: not sent.',
    'La configuration a changé entre-temps : non envoyée.',
  ),
  storage: both(
    'A stop kept in /data could not be lifted there (/data not writable): the command is not sent, so that a restart never sends the stop again over it.',
    'Un arrêt gardé dans /data n’a pas pu y être levé (/data non inscriptible) : la commande n’est pas envoyée, pour qu’un redémarrage ne renvoie jamais l’arrêt par-dessus.',
  ),
  tooSlow: both(
    'The thermostat was too slow to send the command within 15 s of the click: not sent.',
    'Le thermostat a été trop lent pour envoyer la commande dans les 15 s du clic : non envoyée.',
  ),
  unknownState: (reason) =>
    both(
      `The current state could not be read just before (${reason}): not sent.`,
      `L’état actuel n’a pas pu être relu juste avant (${reason}) : non envoyée.`,
    ),
  notSent: (reason) =>
    both(
      `The thermostat could not be reached (${reason}): not sent.`,
      `Le thermostat n’a pas pu être joint (${reason}) : non envoyée.`,
    ),
  refused: (reason) =>
    both(
      `The thermostat refused the command (${reason}): not applied.`,
      `Le thermostat a refusé la commande (${reason}) : non appliquée.`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Sent, without confirmation (${reason}): check the thermostat in a minute.`,
      `Envoyée, sans confirmation (${reason}) : vérifiez le thermostat dans une minute.`,
    ),
  queued: both(
    'Waiting its turn behind other commands (a scene): sent within 15 s of the click, or not at all; check the thermostat in a few seconds.',
    'En attente derrière d’autres commandes (une scène) : envoyée dans les 15 s du clic, ou pas du tout ; vérifiez le thermostat dans quelques secondes.',
  ),
  noAnswerYet: both('no answer yet', 'pas encore de réponse'),
  readBackDiffers: both(
    'the thermostat does not show it yet',
    'le thermostat ne le montre pas encore',
  ),
  stopOtherThermostat: both(
    'Another thermostat answers at the address of the configuration: this one is not there, and the other one is not turned off for it. Nothing sent.',
    'Un autre thermostat répond à l’adresse de la configuration : celui-ci n’y est pas, et l’autre n’est pas éteint à sa place. Rien envoyé.',
  ),
  stopKept: both(
    'Stop not sent yet (no session with the thermostat): it is kept and leaves first as soon as the thermostat answers.',
    'Arrêt pas encore envoyé (pas de session avec le thermostat) : il est gardé et part en premier dès que le thermostat répond.',
  ),
  stopNoAddress: both(
    'No valid address in the configuration: the stop is kept, and sent once an address is saved.',
    'Aucune adresse valide dans la configuration : l’arrêt est gardé, et envoyé dès qu’une adresse est enregistrée.',
  ),
  stopRefused: (reason) =>
    both(
      `The thermostat refused the stop (${reason}): it is tried again at the next checks.`,
      `Le thermostat a refusé l’arrêt (${reason}) : il est retenté aux prochaines vérifications.`,
    ),
};
