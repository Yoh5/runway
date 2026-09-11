# Le film — 95 secondes, plan par plan

## Avant de commencer

**La voix est en ANGLAIS, les indications en français.** Ce que tu lis à voix
haute est dans les blocs « Voice » ; tout le reste ne sort pas de l'écran. Le
jury est anglophone, et un commentaire en français lui coûterait la moitié de
ce que la vidéo démontre.

Chaque bloc est calibré sur la durée de son plan, à environ 150 mots/minute —
c'est un débit de démonstration, pas de conversation. Si tu dois réécrire une
phrase, garde le nombre de mots : c'est lui qui fait tenir le plan.

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

**Voice — read this aloud, in English**
> A treasury that pays in continuous streams can drain while nobody is
> watching. Runway watches its own, and reduces the payments when it falls
> below the threshold.

---

## Plan 2 — Le mandat, écrit à l'avance · 0:10 → 0:25

**Écran** : le fichier de politique. Fais défiler lentement jusqu'aux trois
tiers, et laisse le curseur sur les `floor`.

**Voice — read this aloud, in English**
> Those limits are a file. Three streams, three priorities, and for each one a
> floor — the rate the agent may never go below. It does not decide the policy.
> It applies it.

---

## Plan 3 — Ce que la course a décidé · 0:25 → 0:45

**Écran** : `report.html`. Reste en haut cinq secondes (`Decision: reduce`,
`breach`, `Runway 23h 27m 30s`), puis descends sur le tableau des
ajustements — les trois lignes `budget-shed`.

**Voice — read this aloud, in English**
> On September the eighth, the reserve covered twenty-three more hours. The
> agent decided to reduce, and it started with the least critical stream.
> Discretionary, then standard, then critical. Each one stops exactly at its
> floor. None of them is cut off.

---

## Plan 4 — La preuve on-chain · 0:45 → 1:05

**Écran** : descends jusqu'au tableau `Status / Result`, montre les trois
`landed`, puis bascule sur un onglet Etherscan. Laisse voir le statut
`Success` et le contrat appelé.

**Voice — read this aloud, in English**
> Three writes, three transactions mined on Sepolia. They go through
> Superfluid's own access control list, under a permission that lets the agent
> slow a stream down and stop it — never open one. The treasury can revoke that
> permission in a single call.

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

**Voice — read this aloud, in English**
> And here is why it is verifiable. This command reads the chain live, right
> now. All three streams are still at their floors, to the wei. A mined
> transaction proves an order was sent. This proves it took effect.

---

## Plan 6 — La moitié honnête · 1:20 → 1:35

**Écran** : remonte sur `report.html`, section **Escalations**. Laisse lire
`floors-exceed-budget`.

**Voice — read this aloud, in English**
> And when it is not enough, it says so. It reduced everything down to the
> floors, and the budget still fell short. So it stops there, and escalates the
> rest to a human. That is what makes it usable.

---

## Si tu dois couper

L'ordre de sacrifice, du moins coûteux au plus coûteux :

1. le plan 1 (la couverture) — deux secondes suffisent ;
2. le plan 2 (le fichier de politique) — la voix peut le dire sans le montrer ;
3. **jamais** les plans 5 et 6. La lecture en direct est ce qui distingue une
   démonstration d'une capture d'écran, et l'escalade est ce qui distingue un
   agent utilisable d'un agent qui promet trop.

## Ce qu'il ne faut pas dire

Les formules à éviter sont données en anglais, puisque c'est la langue du
commentaire :

- **« the agent manages the treasury »** — il applique une politique écrite
  d'avance. Dire « manages » promet un jugement qu'il n'a pas.
- **« fully automatic »** — l'escalade existe précisément parce qu'il ne l'est
  pas, et c'est un argument, pas un aveu. Préfère **« it acts on its own within
  a mandate it cannot exceed »**.
- **« it protects the treasury »** — il choisit qui continue d'être payé. C'est
  plus précis, et plus difficile à contester.
- Ne cite aucun chiffre que l'écran ne montre pas au même moment.

Et si tu hésites sur un mot en direct : les trois qui portent la démonstration
sont **mandate**, **floor** et **escalate**. Le reste peut se dire autrement.
