import { createHash } from 'node:crypto';

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

/**
 * Collects leaf tokens from an AST node, skipping comments and whitespace.
 */
export function extractNormalizedTokens(node) {
  const tokens = [];

  function visit(curr) {
    if (!curr) return;
    if (curr.type === 'comment' || curr.type === 'line_comment' || curr.type === 'block_comment') {
      return;
    }

    if (curr.childCount === 0) {
      const text = curr.text;
      if (text.length > 0) {
        tokens.push(text);
      }
      return;
    }

    for (let i = 0; i < curr.childCount; i++) {
      visit(curr.child(i));
    }
  }

  visit(node);
  return tokens;
}

/**
 * Computes a fingerprint of the normalized token stream of an AST node.
 * Comments, blank lines, and formatting differences are stripped out.
 */
export function computeTokenFingerprint(node) {
  if (!node) return sha256('');
  const tokens = extractNormalizedTokens(node);
  return sha256(tokens.join(' '));
}

/**
 * Computes signature fingerprint from parameters and return type annotations.
 */
export function computeSignatureFingerprint(paramsNode, returnTypeNode) {
  const paramTokens = paramsNode ? extractNormalizedTokens(paramsNode) : [];
  const returnTokens = returnTypeNode ? extractNormalizedTokens(returnTypeNode) : [];
  const combined = [...paramTokens, '->', ...returnTokens].join(' ');
  return sha256(combined);
}

/**
 * Computes an AST structure skeleton (node types hierarchy, omitting identifier literals),
 * used for detecting renames where logic was kept but symbols were renamed.
 */
export function computeStructureFingerprint(node) {
  if (!node) return sha256('');
  const types = [];

  function visit(curr) {
    if (!curr) return;
    if (curr.type === 'comment' || curr.type === 'line_comment' || curr.type === 'block_comment') {
      return;
    }
    types.push(curr.type);
    for (let i = 0; i < curr.childCount; i++) {
      visit(curr.child(i));
    }
  }

  visit(node);
  return sha256(types.join(':'));
}
