# Envisalink (DSC, Honeywell)

Cette intégration relie à Gladys une centrale d'alarme **DSC PowerSeries** ou
**Honeywell / Ademco Vista** équipée d'un module **Envisalink EVL-3 ou
EVL-4**, en local, par l'interface TPI du module (port TCP 4025), sans le
cloud EyezOn. Non officielle, sans lien avec EyezOn, DSC ou Honeywell.

> **Jamais testée sur un vrai module.** Cette version a été écrite d'après la
> documentation TPI d'EyezOn et la bibliothèque pyenvisalink, et testée
> seulement contre un module simulé. Essayez-la d'abord centrale désarmée, en
> regardant les journaux, et signalez ce qui diffère dans les
> [issues GitHub](https://github.com/LM1LC3N7/gladys-envisalink/issues).
> Ne comptez pas sur elle comme seule alerte d'intrusion ou d'incendie.

## Ce que vous obtenez

- **Une partition = un appareil** « Alarme partition N » : le **mode**
  (désarmée, armée absent, armée présent, armée nuit), **alarme en cours** et
  **prête à armer**. Le mode se pilote depuis le tableau de bord ou une scène.
- **Une zone = un appareil** : ouverte / fermée (ou mouvement, fumée, fuite
  d'eau selon le type choisi), **alarme**, **autoprotection**, **défaut**.
- **La centrale** : Envisalink connecté, alimentation secteur, batterie
  faible, autoprotection, défaut système, alarme panique.
- **Déclencheurs de scène** : « Alarme Envisalink déclenchée » (avec son
  type : intrusion ou fuite d'eau d'après le type de la zone en alarme,
  incendie, médicale, panique, contrainte, ou « partition en alarme, cause
  inconnue » quand la zone n'est pas configurée), « Partition Envisalink
  armée » (avec le mode, le numéro d'utilisateur s'il est connu, et si la
  demande venait de Gladys), « Partition Envisalink désarmée ».
- **Actions de scène** : armer, désarmer (si autorisé), alarme panique (si
  autorisée).

## Avant de commencer

1. Le module Envisalink doit être sur votre réseau local, avec une adresse
   fixe (réservation DHCP dans votre box).
2. Notez le **mot de passe de la page web locale** du module (« user » par
   défaut). Ce n'est pas le mot de passe du compte EyezOn.
3. **Une seule connexion TPI à la fois** : si Home Assistant, un autre Gladys
   ou un autre logiciel utilise déjà le module, arrêtez-le, sinon les deux
   se déconnecteront l'un l'autre. Pour partager le module entre plusieurs
   logiciels, un relais comme envisalink-proxy est nécessaire.

## Configuration

1. **Adresse de l'Envisalink** : son IP (ex. `192.168.1.40`), éventuellement
   suivie du port (`192.168.1.40:4025`).
2. **Port TPI** : 4025 sauf changement.
3. **Mot de passe de l'Envisalink**.
4. **Centrale d'alarme** : laissez « Automatique » (DSC et Honeywell se
   reconnaissent au premier message du module).
5. **Nombre de partitions** : 1 dans la plupart des maisons.
6. **Zones** (facultatif) : les zones à afficher dès le départ, avec un nom
   et un type, séparées par des virgules :
   `1=Porte d'entrée, 2=Couloir:motion, 5=Cuisine:smoke, 6=Buanderie:leak, 10-12`.
   Types : `opening` (ouverture, par défaut), `motion` (mouvement), `smoke`
   (fumée), `leak` (fuite d'eau). Une zone signalée par la centrale mais
   absente de la liste s'ajoute seule, comme ouverture. Changer le type d'une
   zone crée une nouvelle fonctionnalité : ajoutez-la de nouveau depuis la
   Découverte.
7. Enregistrez, puis ajoutez les appareils depuis l'onglet **Découverte**.

Le bouton **Tester la connexion** se reconnecte immédiatement, demande l'état
complet à la centrale (DSC) et affiche le mode de chaque partition.

## Sécurité

- **L'armement** est permis par défaut (option « Autoriser l'armement »).
- **Le désarmement est désactivé par défaut.** Activez « Autoriser le
  désarmement » seulement si votre Gladys est bien protégé : toute personne
  pouvant piloter vos appareils pourra désarmer l'alarme.
- **Les alarmes panique** depuis Gladys sont désactivées par défaut.
- **Code utilisateur** : DSC 4 ou 6 chiffres, Honeywell 4 chiffres.
  Nécessaire pour désarmer, et pour armer une centrale Honeywell ou une DSC
  sans « armement rapide ». Utilisez de préférence un code dédié. Il n'est
  jamais écrit dans les journaux ; le mot de passe non plus. Chaque commande
  (envoyée ou refusée) est journalisée.
- Une DSC qui demande un code pendant un armement (message 900) ne le reçoit
  que dans les 20 secondes qui suivent une commande Gladys, et seulement pour
  la partition armée.

### Attention aux fausses alarmes

- **Le mode nuit arme sans délai d'entrée** : en ouvrant la porte, l'alarme
  part tout de suite, sans laisser le temps de taper le code. Ne l'armez
  depuis une scène que si personne ne doit rentrer.
- **Si votre centrale est reliée à une télésurveillance**, une alarme
  déclenchée par une scène mal réglée, ou une alarme panique envoyée depuis
  Gladys, est transmise comme une vraie : prévenez votre télésurveilleur
  avant vos essais, ou passez la centrale en mode test.

## Les modes

| Mode Gladys     | DSC                                | Honeywell          |
| --------------- | ---------------------------------- | ------------------ |
| Armée (absent)  | commande 030                       | code + 2 (Away)    |
| Armée (présent) | commande 031                       | code + 3 (Stay)    |
| Armée (nuit)    | commande 032 (sans délai d'entrée) | code + 7 (Instant) |
| Désarmée        | commande 040 + code                | code + 1 (Off)     |

Pour passer d'un mode armé à un autre, désarmez d'abord.

## Limites connues

- Honeywell : la centrale ne signale les zones que par l'afficheur du clavier
  virtuel et un champ de bits pas toujours envoyé. Une zone vue « FAULT »,
  « CHECK » ou « ALARM » sur le clavier redevient normale quand elle n'y est
  plus affichée depuis 45 s, ou dès que la partition est « prête » (sauf
  l'alarme, levée au désarmement). Un « ALARM » affiché par un clavier
  désarmé (mémoire d'alarme) n'est pas une alarme.
- Honeywell, centrale armée : le clavier n'affiche plus les défauts. Une
  porte restée ouverte pendant l'armement apparaît donc **fermée au bout de
  45 s**, sauf si la centrale la signale par son champ de bits (`%01`). Ne
  vous fiez pas à l'état des ouvertures d'une centrale Honeywell armée.
- Honeywell : une partition apparaît **armée dès le début du délai de
  sortie** (les icônes du clavier s'allument tout de suite), alors qu'une
  DSC ne l'est qu'à la fin du délai. Le déclencheur « Partition armée » part
  donc plus tôt sur Honeywell.
- Honeywell : **l'alarme panique est expérimentale** : elle envoie la touche
  A (incendie), B (médicale) ou C (police) du clavier, dont l'effet dépend de
  la programmation de votre centrale.
- L'état d'une zone n'apparaît qu'à son premier changement (ou au premier
  état complet de la centrale).
- Les limites de Gladys (300 états et 300 événements par minute) sont
  respectées : seules les valeurs qui changent sont envoyées (plus un rappel
  toutes les 30 minutes environ) ; au-delà de 240 états par minute, les
  zones attendent la minute suivante, la centrale et les partitions gardant
  leur part ; au-delà de 120 événements de scène par minute, ils sont
  ignorés et journalisés, sauf « Alarme Envisalink déclenchée », jamais
  ignorée et renvoyée jusqu'à 3 fois en cas d'erreur.

## Dépannage

- « Envisalink injoignable » : vérifiez l'adresse, que le module répond
  (page web locale), et qu'aucun autre logiciel n'est connecté au port 4025.
- « un autre client utilise peut-être le TPI » : la connexion se coupe juste
  après l'identification, plusieurs fois de suite ; l'intégration attend
  alors 5 minutes entre deux essais. Arrêtez l'autre logiciel, ou utilisez un
  relais (envisalink-proxy).
- « mot de passe refusé » : après trois refus, la connexion s'arrête pour ne
  pas bloquer le module. Corrigez le mot de passe, puis enregistrez ou
  cliquez sur « Tester la connexion ».
- La connexion est vérifiée par un keep-alive toutes les minutes ; sans
  réponse pendant 3 minutes, l'intégration se reconnecte (5 s, 10 s, 30 s,
  1 min, 2 min, puis toutes les 5 min).
