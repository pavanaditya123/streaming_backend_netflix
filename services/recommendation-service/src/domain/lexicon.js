/**
 * Vocabulary the intent parser matches against.
 *
 * Kept as data (not code) so adding a genre synonym or a new mood does not mean
 * touching the parser at all.
 */

export const GENRE_SYNONYMS = {
  action: ['action', 'fight', 'fighting', 'martial arts'],
  comedy: ['comedy', 'comedies', 'funny', 'humour', 'humor', 'laugh', 'sitcom'],
  drama: ['drama', 'dramas', 'dramatic'],
  thriller: ['thriller', 'thrillers', 'suspense', 'edge of my seat'],
  horror: ['horror', 'scary', 'creepy', 'terrifying', 'frightening'],
  'sci-fi': ['sci-fi', 'scifi', 'science fiction', 'space', 'futuristic'],
  romance: ['romance', 'romantic', 'love story', 'rom com', 'romcom'],
  animation: ['animation', 'animated', 'anime', 'cartoon'],
  documentary: ['documentary', 'documentaries', 'docu'],
  crime: ['crime', 'criminal', 'gangster', 'mafia', 'heist'],
  fantasy: ['fantasy', 'magical', 'magic'],
  mystery: ['mystery', 'mysteries', 'whodunit', 'detective'],
  adventure: ['adventure', 'adventurous', 'quest'],
  family: ['family', 'kids', 'children', 'child friendly', 'family friendly'],
  history: ['history', 'historical', 'period drama'],
  biography: ['biography', 'biopic', 'true story', 'based on a true story'],
  music: ['music', 'musical', 'songs'],
  sport: ['sport', 'sports', 'sporting'],
  nature: ['nature', 'wildlife', 'animals', 'planet']
};

export const MOOD_SYNONYMS = {
  funny: ['funny', 'cheer me up', 'lighthearted', 'light hearted', 'laugh', 'hilarious'],
  scary: ['scary', 'spooky', 'frightening', 'creepy'],
  emotional: ['emotional', 'cry', 'sad', 'tearjerker', 'moving', 'touching'],
  'feel-good': ['feel good', 'feelgood', 'wholesome', 'happy', 'uplifting'],
  tense: ['tense', 'intense', 'gripping', 'nail biting', 'thrilling'],
  'mind-bending': ['mind bending', 'mindbending', 'confusing', 'makes you think', 'twisty', 'plot twist'],
  dark: ['dark', 'gritty', 'bleak'],
  romantic: ['romantic', 'date night'],
  inspiring: ['inspiring', 'inspirational', 'motivating', 'motivational'],
  calming: ['calming', 'relaxing', 'chill', 'background', 'easy watching'],
  nostalgic: ['nostalgic', 'nostalgia', 'classic feel'],
  epic: ['epic', 'grand', 'large scale'],
  whimsical: ['whimsical', 'quirky', 'charming'],
  satirical: ['satire', 'satirical', 'clever'],
  bittersweet: ['bittersweet', 'melancholy']
};

export const LANGUAGE_SYNONYMS = {
  hi: ['hindi', 'bollywood'],
  en: ['english'],
  te: ['telugu', 'tollywood'],
  ta: ['tamil', 'kollywood'],
  kn: ['kannada'],
  ko: ['korean', 'k drama', 'kdrama'],
  ja: ['japanese', 'anime'],
  es: ['spanish'],
  de: ['german'],
  fr: ['french']
};

export const COUNTRY_SYNONYMS = {
  IN: ['india', 'indian'],
  US: ['america', 'american', 'usa', 'hollywood'],
  KR: ['korea', 'korean'],
  JP: ['japan', 'japanese'],
  GB: ['britain', 'british', 'uk'],
  ES: ['spain', 'spanish'],
  DE: ['germany', 'german'],
  FR: ['france', 'french'],
  AU: ['australia', 'australian']
};

export const AWARD_SYNONYMS = {
  oscar: ['oscar', 'oscars', 'academy award', 'academy awards'],
  emmy: ['emmy', 'emmys'],
  filmfare: ['filmfare'],
  'palme-dor': ['palme dor', 'cannes']
};

/** Words that carry no meaning for intent detection. */
export const STOPWORDS = new Set([
  'a', 'an', 'the', 'i', 'me', 'my', 'to', 'for', 'of', 'in', 'on', 'and', 'or',
  'want', 'wanna', 'watch', 'watching', 'show', 'shows', 'something', 'some',
  'please', 'can', 'you', 'give', 'find', 'looking', 'look', 'get', 'is', 'are',
  'what', 'whats', 'do', 'have', 'about', 'with', 'like', 'good', 'best', 'any'
]);
