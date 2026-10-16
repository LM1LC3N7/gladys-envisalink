// -----------------------------------------------------------------------------
// Names and messages, French and English.
// -----------------------------------------------------------------------------

export const word = (entry, language) => entry?.[language] ?? entry?.en ?? '';

/** An entry whose values are functions -> the entry of their results. */
export const fill = (entry, ...args) =>
  Object.fromEntries(
    Object.entries(entry).map(([lang, value]) => [
      lang,
      typeof value === 'function' ? value(...args) : value,
    ]),
  );

export const DEVICE_NAMES = {
  panel: { fr: 'Centrale Envisalink', en: 'Envisalink panel' },
  partition: { fr: (n) => `Alarme partition ${n}`, en: (n) => `Alarm partition ${n}` },
  zone: { fr: (n) => `Zone ${n}`, en: (n) => `Zone ${n}` },
};

export const FEATURE_NAMES = {
  online: { fr: 'Envisalink connecté', en: 'Envisalink connected' },
  'ac-power': { fr: 'Alimentation secteur', en: 'Mains power' },
  'battery-low': { fr: 'Batterie de la centrale faible', en: 'Panel battery low' },
  tamper: { fr: 'Autoprotection', en: 'Tamper' },
  trouble: { fr: 'Défaut système', en: 'System trouble' },
  panic: { fr: 'Alarme panique', en: 'Panic alarm' },
  mode: { fr: 'Mode', en: 'Mode' },
  alarm: { fr: 'Alarme en cours', en: 'Alarm in progress' },
  ready: { fr: 'Prête à armer', en: 'Ready to arm' },
  state: {
    opening: { fr: 'Ouverture', en: 'Opening' },
    motion: { fr: 'Mouvement', en: 'Motion' },
    smoke: { fr: 'Fumée', en: 'Smoke' },
    leak: { fr: "Fuite d'eau", en: 'Water leak' },
  },
  'zone-alarm': { fr: 'Alarme', en: 'Alarm' },
  'zone-tamper': { fr: 'Autoprotection', en: 'Tamper' },
  fault: { fr: 'Défaut', en: 'Fault' },
};

export const MODE_NAMES = {
  disarmed: { fr: 'Désarmée', en: 'Disarmed' },
  armed_away: { fr: 'Armée (absent)', en: 'Armed away' },
  armed_stay: { fr: 'Armée (présent)', en: 'Armed stay' },
  armed_night: { fr: 'Armée (nuit)', en: 'Armed night' },
};

const PANEL = { dsc: 'DSC PowerSeries', honeywell: 'Honeywell Vista' };

const modeList = (partitions, language) =>
  partitions.length === 0
    ? ''
    : ` (${partitions
        .map(({ partition, mode }) =>
          mode
            ? `${partition}: ${word(MODE_NAMES[mode], language).toLowerCase()}`
            : `${partition}: ?`,
        )
        .join(', ')})`;

/** Connection status and button messages. */
export const T = {
  noHost: {
    en: 'Enter the address of the Envisalink in the configuration.',
    fr: "Saisissez l'adresse de l'Envisalink dans la configuration.",
  },
  noPassword: {
    en: 'Enter the password of the Envisalink (the one of its web page, "user" by default).',
    fr: "Saisissez le mot de passe de l'Envisalink (celui de sa page web, « user » par défaut).",
  },
  connecting: {
    en: 'Connecting to the Envisalink…',
    fr: "Connexion à l'Envisalink…",
  },
  connected: {
    en: (type, partitions) =>
      `Connected to the ${PANEL[type] ?? type} panel${modeList(partitions, 'en')}.`,
    fr: (type, partitions) =>
      `Connecté à la centrale ${PANEL[type] ?? type}${modeList(partitions, 'fr')}.`,
  },
  unreachable: {
    en: (reason, seconds) => `Envisalink unreachable (${reason}), next try in ${seconds} s.`,
    fr: (reason, seconds) => `Envisalink injoignable (${reason}), nouvel essai dans ${seconds} s.`,
  },
  refused: {
    en: (seconds) => `The Envisalink refused the password: next try in ${seconds} s.`,
    fr: (seconds) => `L'Envisalink a refusé le mot de passe : nouvel essai dans ${seconds} s.`,
  },
  contended: {
    en: (seconds) =>
      `The Envisalink keeps closing the connection right after the login: another client may be using the TPI (Home Assistant, another Gladys; envisalink-proxy can share it). Next try in ${seconds} s.`,
    fr: (seconds) =>
      `L'Envisalink ferme la connexion juste après l'identification, à chaque fois : un autre client utilise peut-être le TPI (Home Assistant, un autre Gladys ; envisalink-proxy permet de le partager). Nouvel essai dans ${seconds} s.`,
  },
  stopped: {
    en: 'The Envisalink refused the password several times: connection stopped. Fix the password, then save or click "Test the connection".',
    fr: "L'Envisalink a refusé le mot de passe plusieurs fois : connexion arrêtée. Corrigez le mot de passe, puis enregistrez ou cliquez sur « Tester la connexion ».",
  },
  offline: {
    en: 'The Envisalink is not connected: nothing was sent.',
    fr: "L'Envisalink n'est pas connecté : rien n'a été envoyé.",
  },
  armRefused: {
    en: 'Arming from Gladys is disabled in the configuration.',
    fr: "L'armement depuis Gladys est désactivé dans la configuration.",
  },
  disarmRefused: {
    en: 'Disarming from Gladys is disabled in the configuration.',
    fr: 'Le désarmement depuis Gladys est désactivé dans la configuration.',
  },
  panicRefused: {
    en: 'Panic alarms from Gladys are disabled in the configuration.',
    fr: 'Les alarmes panique depuis Gladys sont désactivées dans la configuration.',
  },
  alreadyArmed: {
    en: 'The partition is already armed in another mode: disarm it first.',
    fr: "La partition est déjà armée dans un autre mode : désarmez-la d'abord.",
  },
  noCode: {
    en: 'This command needs the user code of the panel: enter it in the configuration.',
    fr: 'Cette commande demande le code utilisateur de la centrale : saisissez-le dans la configuration.',
  },
  badCode: {
    en: 'The user code must be 4 or 6 digits.',
    fr: 'Le code utilisateur doit compter 4 ou 6 chiffres.',
  },
  badCodeHoneywell: {
    en: 'A Honeywell panel takes a 4-digit user code.',
    fr: 'Une centrale Honeywell prend un code utilisateur à 4 chiffres.',
  },
  unknownPartition: {
    en: (n) => `Partition ${n} is not in the configuration.`,
    fr: (n) => `La partition ${n} n'est pas dans la configuration.`,
  },
  sent: {
    en: (what) => `Sent to the panel: ${what}.`,
    fr: (what) => `Envoyé à la centrale : ${what}.`,
  },
  nothingSent: {
    en: (what) => `Already so (${what}): nothing was sent to the panel.`,
    fr: (what) => `Déjà le cas (${what}) : rien n'a été envoyé à la centrale.`,
  },
  testOk: {
    en: (type, partitions, zones) =>
      `Connected to the ${PANEL[type] ?? type} panel${modeList(partitions, 'en')}, ${zones} zone(s) known.`,
    fr: (type, partitions, zones) =>
      `Connecté à la centrale ${PANEL[type] ?? type}${modeList(partitions, 'fr')}, ${zones} zone(s) connue(s).`,
  },
};

/** What a command did, for the logs and the button messages. */
export const COMMAND_NAMES = {
  arm: {
    en: (mode, p) => `${word(MODE_NAMES[mode], 'en').toLowerCase()}, partition ${p}`,
    fr: (mode, p) => `${word(MODE_NAMES[mode], 'fr').toLowerCase()}, partition ${p}`,
  },
  disarm: { en: (p) => `disarm, partition ${p}`, fr: (p) => `désarmement, partition ${p}` },
  panic: {
    en: (kind) => `${kind} panic`,
    fr: (kind) => `panique ${{ fire: 'incendie', medical: 'médicale', police: 'police' }[kind]}`,
  },
};
