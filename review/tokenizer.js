import { encodingForModel } from 'js-tiktoken';

const encodings = new Map();

export class UnsupportedTokenizerError extends Error {
  constructor(model, options) {
    super(`No tokenizer mapping is available for configured model: ${model}`, options);
    this.name = 'UnsupportedTokenizerError';
  }
}

export function countModelTokens(model, value) {
  let encoding = encodings.get(model);
  if (!encoding) {
    try {
      encoding = encodingForModel(model);
    } catch (error) {
      throw new UnsupportedTokenizerError(model, { cause: error });
    }
    encodings.set(model, encoding);
  }

  return encoding.encode(String(value)).length;
}

export function countRequestTokens(model, request) {
  // Count the serialized instructions, input, and output schema together.
  // The extra headroom covers message framing not represented in JSON.
  return countModelTokens(model, JSON.stringify(request)) + 64;
}
