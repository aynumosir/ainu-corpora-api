import inventoryTsv from "../data/unseeded_words.tsv";
import { parseUnseededWords } from "./unseeded.js";

export const unseededSnapshot = parseUnseededWords(inventoryTsv);
