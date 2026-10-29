# Thermostat Aprilaire (protocole « Home Automation »)

Cette intégration affiche dans Gladys un thermostat Wi-Fi **Aprilaire série 8800** (8810, 8820, 8830,
8840, 8910W, et le 6000 de régulation par zones ; selon des utilisateurs, le 8920W ne propose
pas le mode « Automation ») par son protocole local
« Home Automation », publié par Aprilaire : une connexion TCP sur votre réseau, sans cloud.

**Jamais testé avec un vrai appareil** : l’intégration a été écrite d’après la bibliothèque
pyaprilaire (utilisée par Home Assistant) et testée sur un faux thermostat. Sans lien avec Aprilaire.

## Ce qu’il faut

- Le thermostat en type de connexion **« Automation »** (menu installateur, « Connection Type ») ;
  certains modèles vendus comme domotiques ne le proposent pas et ne sont pas pris en charge.
- Une adresse fixe pour le thermostat dans votre routeur.
- **Une seule connexion domotique** : le thermostat n’accepte qu’une connexion « Automation » à la
  fois (l’application Aprilaire n’est pas concernée). Deux domotiques en même temps peuvent le faire
  cesser de répondre jusqu’à ce qu’on coupe son alimentation. N’utilisez pas en même temps Home
  Assistant ou un autre système sur ce thermostat. L’intégration n’ouvre elle-même qu’une seule
  connexion, gardée ouverte, et n’en rouvre une qu’après la fermeture de la précédente.
- Le protocole n’a **pas de mot de passe** : gardez le thermostat sur un réseau de confiance.

## Configuration

- **Adresse du thermostat** : adresse IPv4 ou nom d’hôte, port 7000 par défaut (ajoutez « :8000 »
  par exemple si le vôtre en utilise un autre).
- **Autoriser les commandes** : désactivé par défaut. Voir plus bas.
- **Intervalle de rafraîchissement** : 60 s par défaut (30 s à 10 min). Le thermostat envoie aussi
  ses changements au fil de l’eau.
- **Langue** des noms, des options et des textes.

Après l’enregistrement, ajoutez le thermostat depuis l’onglet **Découverte**. L’appareil est reconnu
par son **adresse MAC** : il reste le même si son adresse IP change ; un autre thermostat à la même
adresse est un autre appareil (le statut le dit).

## Ce que vous voyez

- Température et humidité (sondes de régulation), température et humidité extérieures si une sonde
  les donne. Une sonde en erreur, absente ou hors plage n’est jamais publiée comme une mesure.
- Consignes de chauffage et de climatisation, en °C (le protocole transporte toujours des °C, quel
  que soit l’affichage du thermostat ; Gladys convertit pour ceux qui préfèrent les °F).
- Mode (arrêt, chauffage, climatisation, auto selon le thermostat ; le chauffage d’appoint est montré
  comme « chauffage »), ventilateur (auto, marche, brassage), fonctionnement (au repos, chauffage,
  climatisation), ventilateur en marche.
- Dérogation (aucune, temporaire, permanente, absence, vacances), erreur du thermostat (E1 à E8).
- Selon l’équipement : humidificateur, déshumidificateur, ventilation (air neuf), purificateur d’air,
  chacun en texte (état, consigne ou mode).

Rien n’est affiché tant que l’adresse MAC n’est pas lue dans la session. Une valeur est publiée
quand elle est lue (ou quand vous ajoutez l’appareil, si elle a été lue moins de 2 minutes avant) ;
jamais une valeur de plus de 2 minutes.

## Les commandes

Avec **Autoriser les commandes** activé, Gladys peut régler :

- le **mode** chauffage, climatisation ou auto (seulement ceux que le thermostat propose) ;
- le **ventilateur** (auto, marche, brassage) ;
- les **consignes** de chauffage et de climatisation, de **4,5 à 32 °C** par pas de 0,5 °C. Ces
  bornes viennent de la plage du fabricant (40 à 99 °F, « 4 à 32 °C ») : les °F convertis
  exactement, ramenés à l’intérieur sur le pas de 0,5 °C, puis dans la plage en °C. Une valeur hors
  bornes est refusée, jamais ramenée dans la plage ; l’octet envoyé est vérifié une seconde fois.

Chaque commande relit d’abord l’état (une lecture partie après le clic), n’écrit que le champ demandé
(les autres restent « inchangés » dans la trame), puis relit : elle n’est réussie que si la relecture
montre la valeur demandée (à 0,5 °C près pour une consigne quand le thermostat affiche des °F : il les
garde en °F entiers) et si le thermostat ne l’a pas refusée. Sinon : « envoyée, sans confirmation »,
puis deux relectures 5 s et 20 s plus tard. Les commandes passent une à une ; une commande en attente
derrière d’autres (une scène) part au plus tard 15 s après le clic, ou pas du tout. En mode auto, le
thermostat peut déplacer l’autre consigne pour garder son écart : c’est lui qui décide.

Pendant qu’un arrêt n’est pas confirmé, les consignes et le ventilateur sont refusés ; un nouveau mode
est accepté et lève l’arrêt quand il part (après l’avoir levé dans `/data` : si `/data` n’est pas
inscriptible, rien n’est envoyé).

## L’arrêt (mode Arrêt)

Choisir le mode **Arrêt** n’est soumis à rien : ni à l’option « Autoriser les commandes », ni à une
lecture préalable, ni à une commande ou une lecture en cours, ni à une session coupée, ni à un
thermostat jamais lu, ni à une configuration pas encore lue après un redémarrage.

- Il part en premier : toute commande cliquée avant lui et pas encore partie est abandonnée ; une
  lecture en cours qui n’a rien reçu depuis 1,5 s est coupée (la session est fermée, puis rouverte
  pour l’arrêt).
- Il est écrit sans lecture avant, puis relu. Il part vers l’adresse de la configuration, sans
  attendre la lecture de l’identité du thermostat ni celle de `/data` (lue 1 s au plus au démarrage,
  reprise ensuite).
- Si une connexion est acceptée puis fermée aussitôt sans un octet du thermostat (une autre domotique
  le tient), l’écriture ne compte pas : l’arrêt est réécrit, chaque seconde pendant les 10 s qui
  suivent le clic, puis chaque minute.
- Sans session (thermostat injoignable), il est **gardé** (en mémoire et dans `/data`) et part dès
  que le thermostat répond ; une nouvelle connexion est tentée au clic, puis au moins chaque minute.
  Un arrêt jamais parti n’est jamais abandonné, même après un redémarrage (il part alors avant même la
  lecture de la configuration).
- Non confirmé, il est vérifié toutes les 15 s pendant 3 minutes puis chaque minute, et renvoyé tant
  que le thermostat montre le mode d’avant, 3 fois au plus par clic (un refus « occupé » du
  thermostat ne compte pas). Il prend fin quand une lecture montre l’arrêt, quand un nouveau mode
  choisi dans Gladys part, ou quand un autre mode est lu deux fois de suite (choisi sur le
  thermostat) ; jamais avec le temps.

Cas où l’arrêt ne part pas (le statut de l’intégration le dit) :

- aucune adresse valide dans la configuration (gardé, il part dès qu’une adresse est enregistrée) ;
- le thermostat ne répond pas ou refuse la connexion (gardé, il part dès qu’il répond) ;
- le thermostat refuse l’écriture (code NACK affiché ; une réponse « occupé » ne compte pas et
  l’arrêt est réécrit à chaque vérification) ;
- un autre thermostat (une autre adresse MAC lue dans la session) répond à l’adresse : l’arrêt
  demandé pour l’appareil d’avant est refusé, rien n’est envoyé à l’autre.

## Limites connues

- Jamais testé avec un vrai appareil ; aucun thermostat nord-américain n’était disponible.
- Les consignes d’humidité, l’air neuf, le purificateur, les dérogations et le programme sont
  seulement affichés dans cette version.
- Un seul thermostat par installation de l’intégration.
