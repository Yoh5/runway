# Le film — 85 secondes, plan par plan

## Avant de commencer

**Enregistre la voix d'abord, filme ensuite en l'écoutant au casque.** Sur un
format court, c'est la voix qui fixe la durée : tu la retravailles jusqu'à ce
qu'elle tienne sans refaire une seule capture, et tes clics tombent
naturellement sur les mots. Filmer d'abord oblige à parler vite pour rentrer
dans un plan trop court, et ça s'entend.

**⚠️ NE LANCE PAS `pnpm tick` DEVANT LA CAMÉRA.** Il diffuse de vraies
transactions. La course qui sert de preuve a déjà eu lieu le 08/09 ; le film
montre son RAPPORT et relit la chaîne, il ne rejoue rien.

**Préparation, avant d'appuyer sur enregistrer**

- quatre onglets ouverts, dans cet ordre : `docs/evidence/report.html`, les
  trois liens Etherscan de `docs/EVIDENCE.md` ;
- un terminal, police agrandie (14-16 pt), fenêtre en 1280×720 au moins ;
- `policies/treasury.sepolia.yaml` ouvert dans l'éditeur ;
- vider l'historique du terminal (`cls`) — un écran encombré coûte trois
  secondes de lecture au juge.

---

## Plan 1 — Ce que le produit résout · 0:00 → 0:10

**Écran** : `docs/brand/runway-cover-1200x630.png` en plein écran, puis fondu
vers `policies/treasury.sepolia.yaml`.

**Voix**
> Une trésorerie qui paie en flux continu peut se vider sans que personne ne
> regarde. Runway surveille la sienne, et quand elle passe sous le seuil, il
> réduit les versements lui-même — dans les limites qu'on lui a fixées.

---

## Plan 2 — Le mandat, écrit à l'avance · 0:10 → 0:25

**Écran** : le fichier de politique. Fais défiler lentement jusqu'aux trois
tiers, et laisse le curseur sur les `floor`.

**Voix**
> Ces limites sont un fichier. Trois flux, trois priorités, et pour chacun un
> plancher : le montant en dessous duquel l'agent n'a pas le droit de
> descendre. Il ne décide pas de la politique, il l'applique.

---

## Plan 3 — Ce que la course a décidé · 0:25 → 0:45

**Écran** : `report.html`. Reste en haut cinq secondes (`Decision: reduce`,
`breach`, `Runway 23h 27m 30s`), puis descends sur le tableau des
ajustements — les trois lignes `budget-shed`.

**Voix**
> Le 8 septembre, la réserve ne couvrait plus que vingt-trois heures. L'agent a
> décidé de réduire, et il a commencé par le flux le moins critique. Le
> discrétionnaire, puis le standard, puis le critique. Chacun s'arrête
> exactement à son plancher — aucun n'est coupé.

---

## Plan 4 — La preuve on-chain · 0:45 → 1:05

**Écran** : descends jusqu'au tableau `Status / Result`, montre les trois
`landed`, puis bascule sur un onglet Etherscan. Laisse voir le statut
`Success` et le contrat appelé.

**Voix**
> Trois écritures, trois transactions minées sur Sepolia. Elles passent par
> l'ACL de Superfluid, avec une autorisation qui permet de modifier et
> d'arrêter un flux — jamais d'en créer un.

---

## Plan 5 — LE PLAN QUI COMPTE : la chaîne relue en direct · 1:05 → 1:20

**Écran** : le terminal. Tape `pnpm verify-rates` et laisse la sortie
s'afficher. Le juge doit voir l'horodatage et le numéro de bloc défiler — c'est
ce qui prouve que la lecture est faite maintenant, pas rejouée.

```
Ethereum Sepolia, block 11674521, read at 2026-09-10T11:03:20.994Z

tier             live rate        committed        floor            at
critical            86791147994     144651913324      86791147994  floor
standard            21697786998      86791147994      21697786998  floor
discretionary       11572153066      57860765330      11572153066  floor
```

**Voix**
> Et voici pourquoi c'est vérifiable. Cette commande relit la chaîne
> maintenant, en direct. Les trois flux sont toujours à leur plancher, au wei
> près. Une transaction minée prouve qu'un ordre est parti ; cette lecture
> prouve qu'il a produit son effet.

---

## Plan 6 — La moitié honnête · 1:20 → 1:30

**Écran** : remonte sur `report.html`, section **Escalations**. Laisse lire
`floors-exceed-budget`.

**Voix**
> Et quand ça ne suffit pas, il le dit. Après avoir tout réduit jusqu'aux
> planchers, il manquait encore. L'agent s'arrête là, remonte l'écart à un
> humain, et ne franchit pas une limite qu'on ne lui a pas donné le droit de
> franchir. C'est ce qui le rend utilisable.

---

## Si tu dois couper

L'ordre de sacrifice, du moins coûteux au plus coûteux :

1. le plan 1 (la couverture) — deux secondes suffisent ;
2. le plan 2 (le fichier de politique) — la voix peut le dire sans le montrer ;
3. **jamais** les plans 5 et 6. La lecture en direct est ce qui distingue une
   démonstration d'une capture d'écran, et l'escalade est ce qui distingue un
   agent utilisable d'un agent qui promet trop.

## Ce qu'il ne faut pas dire

- « L'agent gère la trésorerie » — il applique une politique écrite d'avance.
- « Entièrement automatique » — l'escalade existe justement parce qu'il ne
  l'est pas, et c'est un argument, pas un aveu.
- Ne cite aucun chiffre que l'écran ne montre pas au même moment.
