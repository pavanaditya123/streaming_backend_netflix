// Print the seed catalog as JSON so the Python pipeline reads the same titles
// the services serve, instead of keeping a second copy in sync by hand.
import { TITLES } from '../db/seed/titles.js';

process.stdout.write(JSON.stringify(TITLES));
