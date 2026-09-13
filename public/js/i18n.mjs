// Every string the webapp shows lives here, in each supported language. A test
// checks that both dictionaries have the same keys and placeholders.

export const MESSAGES = {
  en: {
    'app.title': 'Chiplog',
    'nav.log': 'Logbook',
    'nav.export': 'Export',
    'footer.attribution':
      'Map data and place names © OpenStreetMap contributors (ODbL) · Seamarks © OpenSeaMap',

    'unit.knots': 'kn',
    'unit.nauticalMiles': 'nm',

    'common.loading': 'Loading…',
    'common.retry': 'Retry',
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.edit': 'Edit',

    'error.forbidden':
      'Your Signal K account is not allowed to do this. Sign in with an account that has the rights.',
    'error.signIn': 'Open the Signal K admin',
    'error.notRunning': 'The Chiplog plugin is not running. Enable it in the Signal K admin.',
    'error.network': 'The Signal K server cannot be reached.',
    'error.generic': 'Something went wrong: {message}',

    'status.underwaySail': 'Under way under sail',
    'status.underwayEngine': 'Under way under engine',
    'status.underway': 'Under way',
    'status.stopped': 'Stopped',
    'status.unknown': 'Waiting for data',
    'status.currentPassage': 'Current passage',
    'status.fallback':
      'Detected from speed alone: install signalk-autostate for more reliable detection.',

    'log.title': 'Logbook',
    'log.empty':
      'No passage recorded yet. Passages are logged automatically once the vessel gets under way.',
    'log.loadOlder': 'Load older passages',
    'log.inProgress': 'in progress',
    'log.dayDistance': '{distance} sailed',
    'log.fromPreviousDay': 'continued from the previous day',
    'log.toNextDay': 'continues the next day',

    'place.unknown': 'Unnamed place',
    'place.pending': 'Provisional name: waiting for geocoding',

    'passage.back': 'Back to the logbook',
    'passage.notFound': 'This passage does not exist.',
    'passage.inProgress': 'In progress',
    'passage.stoppedSince': 'Stopped since {time}',
    'passage.departure': 'Departure',
    'passage.arrival': 'Arrival',
    'passage.distance': 'Distance',
    'passage.duration': 'Duration',
    'passage.underway': 'Under way',
    'passage.engine': 'Engine',
    'passage.sail': 'Sail',
    'passage.averageSpeed': 'Average speed',
    'passage.track': 'Track',
    'passage.noTrack': 'No track recorded for this passage.',
    'passage.downloadGpx': 'Download the GPX track',
    'passage.propulsion': 'Engine and sail',
    'passage.noPropulsion': 'No engine or sail period recorded.',
    'passage.rpm': '{rpm} rpm',
    'passage.log': 'Log',
    'passage.noLog': 'Nothing logged yet.',

    'map.seamarks': 'Seamarks',

    'timeline.time': 'Time',
    'timeline.position': 'Position',
    'timeline.speed': 'Speed',
    'timeline.course': 'Course',
    'timeline.wind': 'Wind',
    'timeline.depth': 'Depth',
    'timeline.pressure': 'Baro',
    'timeline.remarks': 'Remarks',
    'timeline.apparent': 'app.',
    'timeline.heading': 'hdg',

    'observation.entry_start': 'Departure',
    'observation.entry_end': 'Arrival',
    'observation.periodic': 'Reading',
    'observation.event': 'Reading',

    'event.handwritten': 'Handwritten note',
    'event.sail': 'sail: {sail}',
    'event.alarm': 'Alarm: {message}',
    'event.alarmCleared': 'Alarm cleared: {message}',
    'event.autopilotEngaged': 'Autopilot engaged',
    'event.autopilotDisengaged': 'Autopilot disengaged',
    'event.autopilotMode': 'Autopilot mode: {mode}',
    'event.windAbove': 'Wind above {threshold} (average {speed})',
    'event.windBelow': 'Wind back below {threshold}',
    'event.pressureDrop': 'Barometer down {drop} over 3 h',
    'event.correction': 'Corrected: {before} → {after}',

    'type.engine': 'engine',
    'type.sail': 'sail',

    'manoeuvre.tack': 'Tack',
    'manoeuvre.gybe': 'Gybe',
    'manoeuvre.reef_in': 'Reef in',
    'manoeuvre.reef_out': 'Shake out reef',
    'manoeuvre.sail_change': 'Sail change',
    'manoeuvre.anchor_down': 'Anchor down',
    'manoeuvre.anchor_up': 'Anchor up',
    'manoeuvre.moor': 'Moor',
    'manoeuvre.cast_off': 'Cast off',
    'manoeuvre.watch_change': 'Watch change',

    'corrections.title': 'Corrections',
    'corrections.renameHint':
      'A name you set is remembered and used for later departures and arrivals nearby.',
    'corrections.switchTo': 'Switch to {type}',
    'corrections.close': 'Close this passage',
    'corrections.closeConfirm':
      'Close this passage now? If the vessel has already stopped, the passage ends when it stopped.',
    'corrections.mergePrevious': 'Merge with the previous passage',
    'corrections.mergeNext': 'Merge with the next passage',
    'corrections.mergeConfirm': 'Merge with “{other}”? The two passages will become one.',
    'corrections.delete': 'Delete this passage',
    'corrections.deleteConfirm':
      'Delete this passage, its track and its log lines? This cannot be undone.',

    'export.title': 'Export',
    'export.intro': 'Download the logbook, whole or for a period.',
    'export.from': 'From',
    'export.to': 'To',
    'export.allHint': 'Leave the dates empty to export everything.',
    'export.invalidRange': 'The end date cannot be before the start date.',
    'export.json': 'JSON — the complete record',
    'export.csv': 'CSV — logbook lines for a spreadsheet',
    'export.gpx': 'GPX — tracks',
    'export.pdf': 'PDF — logbook facsimile, coming in V1.1',
    'export.usbTitle': 'USB drive',
    'export.usbIntro':
      'Write the whole logbook to the USB drive set in the plugin configuration, so it can be recovered if the vessel has to be abandoned.',
    'export.usbWrite': 'Write to the USB drive now',
    'export.usbWritten': 'Passages written: {count}, in {directory}',
    'export.usbNotConfigured': 'No USB drive directory is set. Add it in the plugin configuration.',
    'export.usbUnavailable':
      'The USB drive directory is not available: is the drive plugged in and mounted?',
    'export.pluginConfiguration': 'Plugin configuration'
  },

  fr: {
    'app.title': 'Chiplog',
    'nav.log': 'Journal',
    'nav.export': 'Export',
    'footer.attribution':
      'Données cartographiques et noms de lieux © contributeurs OpenStreetMap (ODbL) · Balisage © OpenSeaMap',

    'unit.knots': 'nd',
    'unit.nauticalMiles': 'M',

    'common.loading': 'Chargement…',
    'common.retry': 'Réessayer',
    'common.save': 'Enregistrer',
    'common.cancel': 'Annuler',
    'common.edit': 'Modifier',

    'error.forbidden':
      'Votre compte Signal K n’a pas les droits pour cette action. Connectez-vous avec un compte autorisé.',
    'error.signIn': 'Ouvrir l’administration Signal K',
    'error.notRunning':
      'Le plugin Chiplog n’est pas démarré. Activez-le dans l’administration Signal K.',
    'error.network': 'Le serveur Signal K est injoignable.',
    'error.generic': 'Une erreur est survenue : {message}',

    'status.underwaySail': 'En route à la voile',
    'status.underwayEngine': 'En route au moteur',
    'status.underway': 'En route',
    'status.stopped': 'À l’arrêt',
    'status.unknown': 'En attente de données',
    'status.currentPassage': 'Navigation en cours',
    'status.fallback':
      'Détection d’après la vitesse seule : installez signalk-autostate pour une détection plus fiable.',

    'log.title': 'Journal de bord',
    'log.empty':
      'Aucune navigation enregistrée pour l’instant. Elles sont notées automatiquement dès que le bateau fait route.',
    'log.loadOlder': 'Charger les navigations plus anciennes',
    'log.inProgress': 'en cours',
    'log.dayDistance': '{distance} parcourus',
    'log.fromPreviousDay': 'suite de la veille',
    'log.toNextDay': 'se poursuit le lendemain',

    'place.unknown': 'Lieu sans nom',
    'place.pending': 'Nom provisoire : en attente du géocodage',

    'passage.back': 'Retour au journal',
    'passage.notFound': 'Cette navigation n’existe pas.',
    'passage.inProgress': 'En cours',
    'passage.stoppedSince': 'À l’arrêt depuis {time}',
    'passage.departure': 'Départ',
    'passage.arrival': 'Arrivée',
    'passage.distance': 'Distance',
    'passage.duration': 'Durée',
    'passage.underway': 'En route',
    'passage.engine': 'Moteur',
    'passage.sail': 'Voile',
    'passage.averageSpeed': 'Vitesse moyenne',
    'passage.track': 'Trace',
    'passage.noTrack': 'Aucune trace enregistrée pour cette navigation.',
    'passage.downloadGpx': 'Télécharger la trace GPX',
    'passage.propulsion': 'Moteur et voile',
    'passage.noPropulsion': 'Aucune période moteur ou voile enregistrée.',
    'passage.rpm': '{rpm} tr/min',
    'passage.log': 'Journal',
    'passage.noLog': 'Rien de noté pour l’instant.',

    'map.seamarks': 'Balisage',

    'timeline.time': 'Heure',
    'timeline.position': 'Position',
    'timeline.speed': 'Vitesse',
    'timeline.course': 'Route',
    'timeline.wind': 'Vent',
    'timeline.depth': 'Fond',
    'timeline.pressure': 'Baro',
    'timeline.remarks': 'Observations',
    'timeline.apparent': 'app.',
    'timeline.heading': 'cap',

    'observation.entry_start': 'Départ',
    'observation.entry_end': 'Arrivée',
    'observation.periodic': 'Relevé',
    'observation.event': 'Relevé',

    'event.handwritten': 'Note manuscrite',
    'event.sail': 'voile : {sail}',
    'event.alarm': 'Alarme : {message}',
    'event.alarmCleared': 'Fin d’alarme : {message}',
    'event.autopilotEngaged': 'Pilote automatique embrayé',
    'event.autopilotDisengaged': 'Pilote automatique débrayé',
    'event.autopilotMode': 'Mode du pilote : {mode}',
    'event.windAbove': 'Vent au-dessus de {threshold} (moyenne {speed})',
    'event.windBelow': 'Vent retombé sous {threshold}',
    'event.pressureDrop': 'Baromètre en baisse de {drop} en 3 h',
    'event.correction': 'Corrigé : {before} → {after}',

    'type.engine': 'moteur',
    'type.sail': 'voile',

    'manoeuvre.tack': 'Virement de bord',
    'manoeuvre.gybe': 'Empannage',
    'manoeuvre.reef_in': 'Prise de ris',
    'manoeuvre.reef_out': 'Largage de ris',
    'manoeuvre.sail_change': 'Changement de voile',
    'manoeuvre.anchor_down': 'Mouillage',
    'manoeuvre.anchor_up': 'Ancre levée',
    'manoeuvre.moor': 'Amarrage',
    'manoeuvre.cast_off': 'Appareillage',
    'manoeuvre.watch_change': 'Changement de quart',

    'corrections.title': 'Corrections',
    'corrections.renameHint':
      'Un nom saisi est retenu et réutilisé pour les départs et arrivées suivants à proximité.',
    'corrections.switchTo': 'Passer en {type}',
    'corrections.close': 'Clore cette navigation',
    'corrections.closeConfirm':
      'Clore cette navigation maintenant ? Si le bateau est déjà arrêté, elle se termine au moment de l’arrêt.',
    'corrections.mergePrevious': 'Fusionner avec la navigation précédente',
    'corrections.mergeNext': 'Fusionner avec la navigation suivante',
    'corrections.mergeConfirm':
      'Fusionner avec « {other} » ? Les deux navigations n’en feront plus qu’une.',
    'corrections.delete': 'Supprimer cette navigation',
    'corrections.deleteConfirm':
      'Supprimer cette navigation, sa trace et ses lignes de journal ? C’est irréversible.',

    'export.title': 'Export',
    'export.intro': 'Téléchargez le journal, en entier ou sur une période.',
    'export.from': 'Du',
    'export.to': 'Au',
    'export.allHint': 'Laissez les dates vides pour tout exporter.',
    'export.invalidRange': 'La date de fin ne peut pas précéder la date de début.',
    'export.json': 'JSON — l’enregistrement complet',
    'export.csv': 'CSV — les lignes du journal, pour un tableur',
    'export.gpx': 'GPX — les traces',
    'export.pdf': 'PDF — fac-similé du journal, prévu en V1.1',
    'export.usbTitle': 'Clé USB',
    'export.usbIntro':
      'Écrire tout le journal sur la clé USB indiquée dans la configuration du plugin, pour le récupérer en cas d’abandon du navire.',
    'export.usbWrite': 'Écrire sur la clé USB maintenant',
    'export.usbWritten': 'Navigations écrites : {count}, dans {directory}',
    'export.usbNotConfigured':
      'Aucun dossier de clé USB n’est indiqué. Ajoutez-le dans la configuration du plugin.',
    'export.usbUnavailable':
      'Le dossier de la clé USB est indisponible : la clé est-elle branchée et montée ?',
    'export.pluginConfiguration': 'Configuration du plugin'
  }
};

export const LANGUAGES = Object.keys(MESSAGES);

// `?lang=` wins, then the browser's preferred languages, then English.
export function pickLanguage(browserLanguages = [], search = '') {
  const requested = new URLSearchParams(search).get('lang');
  const candidates = [requested, ...browserLanguages].filter(Boolean);
  for (const candidate of candidates) {
    const base = candidate.toLowerCase().split('-')[0];
    if (LANGUAGES.includes(base)) {
      return base;
    }
  }
  return 'en';
}

export function createTranslator(language) {
  const messages = MESSAGES[language] ?? MESSAGES.en;
  function t(key, params = {}) {
    const template = messages[key] ?? MESSAGES.en[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      params[name] === undefined ? match : String(params[name])
    );
  }
  t.has = (key) => key in messages || key in MESSAGES.en;
  return t;
}
