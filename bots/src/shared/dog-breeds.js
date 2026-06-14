/**
 * Bot display names: randomly chosen dog breeds (spec constraint).
 *
 * Names must be (a) random-feeling, (b) unique within a session so operators
 * can tell bots apart in Jitsi/Jamulus, and (c) reproducible from (botId,
 * sessionSeed) so a replaced bot's logs can be correlated. We get all three by
 * seeding a Fisher-Yates shuffle with the session seed and indexing by botId.
 *
 * The single DOG_BREEDS list holds general breeds plus all scent hound breeds
 * (FCI Group 6 and the AKC/UKC coonhound scent breeds).
 */

export const DOG_BREEDS = [
  // General breeds
  'Affenpinscher', 'Akita', 'Basenji', 'Bernese Mountain Dog',
  'Border Collie', 'Borzoi', 'Boxer', 'Brittany', 'Bullmastiff',
  'Cairn Terrier', 'Chow Chow', 'Dalmatian', 'Doberman', 'Great Dane',
  'Greyhound', 'Havanese', 'Irish Setter', 'Keeshond', 'Komondor',
  'Leonberger', 'Malamute', 'Newfoundland', 'Papillon', 'Pomeranian',
  'Pug', 'Rottweiler', 'Saluki', 'Samoyed', 'Schipperke', 'Shiba Inu',
  'Vizsla', 'Weimaraner', 'Whippet',
  // Scent hounds
  'Alpine Dachsbracke', 'American English Coonhound', 'American Foxhound',
  'Anglo-Francais de Petite Venerie', 'Ariegeois', 'Artois Hound',
  'Austrian Black and Tan Hound', 'Basset Artesien Normand',
  'Basset Bleu de Gascogne', 'Basset Fauve de Bretagne', 'Basset Hound',
  'Bavarian Mountain Hound', 'Beagle', 'Beagle-Harrier', 'Bernese Hound',
  'Billy', 'Black and Tan Coonhound', 'Bloodhound', 'Bluetick Coonhound',
  'Bosnian Coarse-haired Hound', 'Briquet Griffon Vendeen', 'Drever',
  'Dunker', 'English Foxhound', 'Estonian Hound', 'Finnish Hound',
  'Francais Blanc et Noir', 'Francais Blanc et Orange', 'Francais Tricolore',
  'German Hound', 'Grand Anglo-Francais Blanc et Noir',
  'Grand Anglo-Francais Blanc et Orange', 'Grand Anglo-Francais Tricolore',
  'Grand Basset Griffon Vendeen', 'Grand Bleu de Gascogne',
  'Grand Gascon Saintongeois', 'Grand Griffon Vendeen', 'Greek Harehound',
  'Griffon Bleu de Gascogne', 'Griffon Fauve de Bretagne', 'Griffon Nivernais',
  'Haldenstovare', 'Hamiltonstovare', 'Hanover Hound', 'Harrier',
  'Hungarian Hound', 'Hygen Hound', 'Istrian Coarse-haired Hound',
  'Istrian Shorthaired Hound', 'Jura Hound', 'Lithuanian Hound',
  'Lucerne Hound', 'Montenegrin Mountain Hound', 'Otterhound',
  'Petit Basset Griffon Vendeen', 'Petit Bleu de Gascogne',
  'Petit Gascon Saintongeois', 'Plott Hound', 'Poitevin', 'Polish Hound',
  'Polish Hunting Dog', 'Porcelaine', 'Posavac Hound', 'Redbone Coonhound',
  'Russian Harlequin Hound', 'Russian Hound', 'Schillerstovare',
  'Schwyz Hound', 'Segugio Italiano', 'Segugio Maremmano', 'Serbian Hound',
  'Serbian Tricolour Hound', 'Slovakian Hound', 'Smalandsstovare',
  'Spanish Hound', 'Styrian Coarse-haired Hound', 'Swiss Niederlaufhund',
  'Transylvanian Hound', 'Treeing Walker Coonhound', 'Tyrolean Hound',
  'Westphalian Dachsbracke',
];

// mulberry32: tiny deterministic PRNG; quality is irrelevant here, we only
// need a stable shuffle per session seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function breedNameFor(botId, sessionSeed = 0, pool = DOG_BREEDS) {
  const rand = mulberry32(sessionSeed);
  const deck = [...pool];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck[botId % deck.length];
}
