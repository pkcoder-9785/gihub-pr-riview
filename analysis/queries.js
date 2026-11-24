import {
  computeTokenFingerprint,
  computeSignatureFingerprint,
  computeStructureFingerprint,
} from './fingerprint.js';
import { redact } from '../review/safety.js';

function isOptionalCall(node) {
  // Only the uninterrupted callee/receiver chain can short-circuit this call.
  let current = node;
  while (current) {
    const type = current.type;
    if (type !== 'call_expression' && type !== 'member_expression' && type !== 'subscript_expression') break;
    if (current.children.some((child) => child.type === 'optional_chain' || child.type === '?.')) return true;
    current = current.childForFieldName(type === 'call_expression' ? 'function' : 'object');
  }
  return false;
}

function toRange(node) {
  return {
    start: { line: node.startPosition.row + 1, column: node.startPosition.column },
    end: { line: node.endPosition.row + 1, column: node.endPosition.column },
  };
}

function stripQuotes(text) {
  return text ? text.replace(/^['"`]|['"`]$/g, '') : '';
}

function rangesOverlap(r1, r2) {
  if (r1.end.line < r2.start.line || (r1.end.line === r2.start.line && r1.end.column <= r2.start.column)) {
    return false;
  }
  if (r1.start.line > r2.end.line || (r1.start.line === r2.end.line && r1.start.column >= r2.end.column)) {
    return false;
  }
  return true;
}

/**
 * Extracts all symbols, imports, exports, calls, JSX usages, value references,
 * extends/implements, identifiers, and parse diagnostics from a Tree-sitter AST.
 */
export function extractFileFacts(rootNode, filePath, language, captures = null) {
  // Queries identify import/export/call sites; tree inspection assigns bindings/scopes.
  const captured = (node) => !captures || captures.has(`${node.type}:${node.startIndex}:${node.endIndex}`);
  const symbols = [];
  const imports = [];
  const exports = [];
  const callSites = [];
  const jsxUsages = [];
  const valueReferences = [];
  const extendsImplements = [];
  const usedIdentifiers = new Set();
  const uncertainBindings = new Set();
  const typeBindings = [];
  const riskSignals = [];
  let cjsObjectWrites = 0;
  let cjsAliasWrites = 0;
  let cjsShadowedGlobal = false;
  let bindingEvidenceComplete = true;
  const byteOffset = (node) => Buffer.byteLength(rootNode.text.slice(0, node.startIndex), 'utf8');
  const diagnostics = [];
  const errorRanges = [];

  // 1. Collect all ERROR/MISSING nodes upfront
  function collectErrors(curr) {
    if (!curr) return;
    if (curr.isError || curr.type === 'ERROR' || curr.isMissing) {
      const range = toRange(curr);
      errorRanges.push(range);
      diagnostics.push({
        level: 'error',
        message: curr.isMissing
          ? `Missing expected token at ${curr.startPosition.row + 1}:${curr.startPosition.column}`
          : `Syntax error near '${curr.text.slice(0, 40).replace(/\s+/g, ' ')}'`,
        range,
      });
    }
    for (let i = 0; i < curr.childCount; i++) collectErrors(curr.child(i));
  }
  collectErrors(rootNode);

  function hasErrorOverlap(range) {
    return errorRanges.some((errRange) => rangesOverlap(range, errRange));
  }

  function addUsedIdentifier(id) {
    if (!id || typeof id !== 'string') return;
    const trimmed = id.trim();
    if (!trimmed || ['true', 'false', 'null', 'undefined', 'async', 'await'].includes(trimmed)) return;
    // Filter secrets or secret-like tokens
    if (redact(trimmed) !== trimmed || /^(?:gh[pousr]_[A-Za-z0-9_]{15,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})$/i.test(trimmed)) {
      return;
    }
    if (trimmed.length > 32 && /^[A-Za-z0-9+/=_-]+$/.test(trimmed)) {
      return;
    }
    usedIdentifiers.add(trimmed);
  }

  function isModuleTopLevel(node) {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.type === 'program') return true;
      if (['statement_block', 'function_declaration', 'arrow_function', 'function_expression', 'method_definition', 'if_statement', 'switch_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'try_statement', 'catch_clause', 'conditional_expression'].includes(parent.type)) return false;
    }
    return false;
  }

  const scopeStack = ['global'];
  const scopeSymbolCounts = new Map();

  function currentScope() {
    return scopeStack[scopeStack.length - 1];
  }

  const symbolStack = [];
  function currentEnclosingSymbolKey() {
    return symbolStack.at(-1) ?? null;
  }

  function addSymbol({ name, kind, node, paramsNode = null, bodyNode = null, returnTypeNode = null, exportedNames = [] }) {
    const scope = currentScope();
    const countKey = `${scope}#${kind}:${name}`;
    const ordinal = scopeSymbolCounts.get(countKey) || 0;
    scopeSymbolCounts.set(countKey, ordinal + 1);

    const symbolKey = `${filePath}#${scope}#${kind}:${name}#${ordinal}`;
    const range = toRange(node);
    const hasParseError = hasErrorOverlap(range);

    const effectiveNode = node.type === 'variable_declarator' && bodyNode?.parent ? bodyNode.parent : node;
    const modifiers = effectiveNode.children.filter((child) => ['public', 'private', 'protected', 'static', 'async'].includes(child.text)).map((child) => child.text);
    const parameters = (paramsNode ? (paramsNode.type === 'formal_parameters' ? paramsNode.namedChildren : [paramsNode]) : []).map((param) => ({
      name: (param.childForFieldName('pattern') || param.childForFieldName('name') || param).text.split(/[=?:]/)[0].trim(),
      optional: param.text.includes('?'),
      hasDefault: Boolean(param.childForFieldName('value')) || param.type === 'assignment_pattern',
      defaultFingerprint: (param.childForFieldName('value') || param.childForFieldName('right')) ? computeTokenFingerprint(param.childForFieldName('value') || param.childForFieldName('right')) : null,
    }));
    const returns = [];
    let throws = false;
    const throwFingerprints = [];
    function collectContract(part) {
      if (!part) return;
      if (part !== bodyNode && ['function_declaration', 'arrow_function', 'function_expression', 'method_definition'].includes(part.type)) return;
      if (part.type === 'return_statement') {
        const value = part.namedChildren[0];
        returns.push(value?.type === 'object' ? `object:${value.namedChildren.map((item) => item.childForFieldName('key')?.text || item.text).sort().join(',')}` : value?.type || 'void');
      }
      if (part.type === 'throw_statement') { throws = true; throwFingerprints.push(computeTokenFingerprint(part)); }
      for (let i = 0; i < part.childCount; i++) collectContract(part.child(i));
    }
    collectContract(bodyNode);
    let lexical = node.parent;
    while (lexical && !['program', 'statement_block'].includes(lexical.type)) lexical = lexical.parent;
    const lexicalScope = lexical ? { start: byteOffset(lexical), end: byteOffset(lexical) + Buffer.byteLength(lexical.text, 'utf8') } : null;
    symbols.push({
      symbolKey,
      name,
      kind,
      scope,
      exportedNames,
      range,
      signatureFingerprint: computeSignatureFingerprint(paramsNode, returnTypeNode),
      bodyFingerprint: computeTokenFingerprint(bodyNode || node),
      structureFingerprint: computeStructureFingerprint(bodyNode || node),
      confidence: hasParseError ? 'low' : 'high',
      hasParseError,
      enclosingSymbolKey: currentEnclosingSymbolKey(),
      byteOffset: byteOffset(node),
      endByte: byteOffset(node) + Buffer.byteLength(node.text, 'utf8'),
      declarationKind: name === 'constructor' && kind === 'method' ? 'constructor' : effectiveNode.type.includes('generator') ? 'generator' : ({ arrow_function: 'arrow', function: 'function', method: 'method', class: 'class' }[kind] || 'other'),
      ...(lexicalScope ? { lexicalScope } : {}),
      contract: { async: modifiers.includes('async') || effectiveNode.text.startsWith('async '), generator: effectiveNode.type.includes('generator') || effectiveNode.children.some((child) => child.text === '*'), parameters, modifiers, returns, throws, throwFingerprints },
    });
    return symbolKey;
  }

  function checkExportContext(node) {
    let curr = node.parent;
    while (curr) {
      if (curr.type === 'export_statement') {
        const isDefault = curr.children.some((c) => c.text === 'default');
        return { isExported: true, isDefault };
      }
      if (curr.type === 'program' || curr.type === 'statement_block') break;
      curr = curr.parent;
    }
    return { isExported: false, isDefault: false };
  }

  function handleImportStatement(node) {
    let source = '';
    const specifiers = [];
    const isTypeOnly = node.children.some((c) => c.text === 'type' && c.type !== 'identifier');

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'string') {
        source = stripQuotes(child.text);
      } else if (child.type === 'import_clause') {
        for (let j = 0; j < child.childCount; j++) {
          const clauseChild = child.child(j);
          if (clauseChild.type === 'identifier') {
            specifiers.push({ imported: 'default', local: clauseChild.text, isTypeOnly });
            addUsedIdentifier(clauseChild.text);
          } else if (clauseChild.type === 'named_imports') {
            for (let k = 0; k < clauseChild.childCount; k++) {
              const spec = clauseChild.child(k);
              if (spec.type === 'import_specifier') {
                const nameNode = spec.childForFieldName('name') || spec.child(0);
                const aliasNode = spec.childForFieldName('alias');
                const isSpecTypeOnly = isTypeOnly || spec.children.some((c) => c.text === 'type');
                const importedName = nameNode ? nameNode.text : '';
                const localName = aliasNode ? aliasNode.text : importedName;
                if (importedName) {
                  specifiers.push({ imported: importedName, local: localName, isTypeOnly: isSpecTypeOnly });
                  addUsedIdentifier(localName);
                }
              }
            }
          } else if (clauseChild.type === 'namespace_import') {
            const alias = clauseChild.childForFieldName('alias') || clauseChild.children.find((c) => c.type === 'identifier');
            if (alias) {
              specifiers.push({ imported: '*', local: alias.text, isTypeOnly });
              addUsedIdentifier(alias.text);
            }
          }
        }
      }
    }

    if (source) {
      imports.push({
        source,
        specifiers,
        isDynamic: false,
        kind: 'esm',
        byteOffset: byteOffset(node),
        range: toRange(node),
      });
    }
  }

  function handleExportStatement(node) {
    const isTypeOnly = node.children.some((c) => c.text === 'type' && c.type !== 'identifier');
    const sourceNode = node.childForFieldName('source') || node.children.find((c) => c.type === 'string');
    const reexportSource = sourceNode ? stripQuotes(sourceNode.text) : null;

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'export_clause') {
        for (let j = 0; j < child.childCount; j++) {
          const spec = child.child(j);
          if (spec.type === 'export_specifier') {
            const nameNode = spec.childForFieldName('name') || spec.child(0);
            const aliasNode = spec.childForFieldName('alias');
            const local = nameNode ? nameNode.text : '';
            const name = aliasNode ? aliasNode.text : local;
            const isSpecTypeOnly = isTypeOnly || spec.children.some((c) => c.text === 'type');
            if (name) {
              exports.push({
                name,
                local,
                isTypeOnly: isSpecTypeOnly,
                reexportSource,
                byteOffset: byteOffset(spec),
                range: toRange(spec),
              });
              if (local) addUsedIdentifier(local);
            }
          }
        }
      } else if (child.text === '*' && reexportSource) {
        exports.push({
          name: '*',
          local: '*',
          isTypeOnly,
          reexportSource,
          byteOffset: byteOffset(node),
          range: toRange(node),
        });
      }
    }
  }

  function walk(node) {
    if (!node) return;

    if (node.type === 'with_statement' || (node.type === 'call_expression' && node.childForFieldName('function')?.text === 'eval')) bindingEvidenceComplete = false;
    // Conservative: any parameter or assignment can shadow/rebind a name.
    if ((node.type === 'formal_parameters' || node.type === 'catch_clause' || node.type === 'for_in_statement' || node.type === 'assignment_expression' || node.type === 'update_expression' || (node.type === 'variable_declarator' && ['object_pattern', 'array_pattern'].includes(node.childForFieldName('name')?.type) && !(node.childForFieldName('value')?.type === 'call_expression' && node.childForFieldName('value')?.childForFieldName('function')?.text === 'require' && isModuleTopLevel(node))) || (node.type === 'arrow_function' && node.childForFieldName('parameter'))) && !(node.type === 'assignment_expression' && /^(?:exports|module\.exports)(?:\.|$)/.test(node.childForFieldName('left')?.text || ''))) {
      const collectNames = (part) => {
        if (['identifier', 'property_identifier', 'shorthand_property_identifier_pattern'].includes(part.type)) { uncertainBindings.add(part.text); if (node.type === 'formal_parameters' && ['module', 'exports', 'require'].includes(part.text)) cjsShadowedGlobal = true; }
        for (let i = 0; i < part.childCount; i++) collectNames(part.child(i));
      };
      collectNames(node.type === 'assignment_expression' ? (node.childForFieldName('left') || node) : node.type === 'variable_declarator' ? node.childForFieldName('name') : node.type === 'arrow_function' ? node.childForFieldName('parameter') : node);
    }
    // Collect identifier tokens (filtered against secrets)
    if (node.type === 'identifier' || node.type === 'property_identifier' || node.type === 'type_identifier') {
      const idText = node.text.trim();
      addUsedIdentifier(idText);
    }

    if (node.type === 'member_expression' && node.text === 'process.env') riskSignals.push({ kind: 'env_access', range: toRange(node) });
    if (node.type === 'call_expression') {
      const name = node.childForFieldName('function')?.text || '';
      if (/^(?:app|router)\.(?:get|post|put|patch|delete|use|all)$/.test(name)) riskSignals.push({ kind: 'route_registration', range: toRange(node) });
    }
    // Type annotations suggest a receiver type; they do not prove its runtime class.
    if (node.type === 'public_field_definition' || node.type === 'required_parameter' || node.type === 'optional_parameter') {
      const classKey = [...symbolStack].reverse().find((key) => symbols.some((symbol) => symbol.symbolKey === key && symbol.kind === 'class'));
      const name = node.childForFieldName('name') || node.childForFieldName('pattern');
      const annotation = node.childForFieldName('type')?.namedChildren?.find((child) => child.type === 'type_identifier');
      const isField = node.type === 'public_field_definition';
      const isParameterProperty = !isField && node.namedChildren.some((child) => child.type === 'accessibility_modifier' || child.text === 'readonly');
      if (classKey && name && annotation && (isField || isParameterProperty)) typeBindings.push({ name: `this.${name.text}`, typeName: annotation.text, exactNew: false, enclosingSymbolKey: classKey });
    }
    // Handle imports
    if (node.type === 'import_statement' && captured(node)) {
      handleImportStatement(node);
    }

    // Handle exports
    if (node.type === 'export_statement' && captured(node)) {
      handleExportStatement(node);
    }

    // Extract static CommonJS exports only. Unknown forms remain unresolved.
    if (node.type === 'assignment_expression') {
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      const expr = left?.text || '';
      const addExport = (name, local) => {
        if (!name || !local) return;
        if (exports.some((item) => item.name === name)) bindingEvidenceComplete = false;
        exports.push({ name, local, isTypeOnly: false, reexportSource: null, range: toRange(node) });
      };
      if (/^(?:exports|module\.exports)(?:\.|$)/.test(expr) && !isModuleTopLevel(node)) bindingEvidenceComplete = false;
      if (expr === 'module.exports') { cjsObjectWrites++; if (cjsObjectWrites > 1 || cjsAliasWrites > 0) bindingEvidenceComplete = false; }
      else if (expr.startsWith('exports.')) { cjsAliasWrites++; if (cjsObjectWrites > 0) bindingEvidenceComplete = false; }
      if (expr === 'module.exports' && right?.type === 'identifier') addExport('default', right.text);
      else if (expr === 'module.exports' && ['function_expression', 'arrow_function'].includes(right?.type)) addExport('default', right.childForFieldName('name')?.text || 'anonymous');
      else if (expr === 'module.exports' && right?.type === 'object') {
        for (const item of right.namedChildren) {
          if (item.type === 'shorthand_property_identifier') addExport(item.text, item.text);
          else if (item.type === 'pair' && item.childForFieldName('value')?.type === 'identifier') addExport(item.childForFieldName('key')?.text, item.childForFieldName('value').text);
          else bindingEvidenceComplete = false;
        }
      } else if (/^(?:exports|module\.exports)\.[A-Za-z_$][\w$]*$/.test(expr) && right?.type === 'identifier') addExport(expr.split('.').at(-1), right.text);
      else if (/^(?:exports|module\.exports)\.[A-Za-z_$][\w$]*$/.test(expr) && ['function_expression', 'arrow_function'].includes(right?.type)) addExport(expr.split('.').at(-1), right.childForFieldName('name')?.text || 'anonymous');
      else if (/^(?:exports|module\.exports)(?:\.|$)/.test(expr)) bindingEvidenceComplete = false;
    }

    // CommonJS require call
    if (node.type === 'call_expression' && captured(node)) {
      const functionNode = node.childForFieldName('function') || node.child(0);
      const argsNode = node.childForFieldName('arguments') || node.child(1);

      if (functionNode && functionNode.text === 'require' && argsNode && argsNode.firstNamedChild?.type === 'string') {
        const source = stripQuotes(argsNode.firstNamedChild.text);
        let specifiers = [{ imported: 'default', local: 'require_res', isTypeOnly: false }];

        if (node.parent?.type === 'variable_declarator') {
          const pattern = node.parent.childForFieldName('name') || node.parent.child(0);
          if (pattern?.type === 'identifier') {
            specifiers = [{ imported: 'default', local: pattern.text, isTypeOnly: false }];
            addUsedIdentifier(pattern.text);
          } else if (pattern?.type === 'object_pattern') {
            specifiers = [];
            for (let i = 0; i < pattern.childCount; i++) {
              const p = pattern.child(i);
              if (p.type === 'shorthand_property_identifier' || p.type === 'shorthand_property_identifier_pattern') {
                specifiers.push({ imported: p.text, local: p.text, isTypeOnly: false });
                addUsedIdentifier(p.text);
              } else if (p.type === 'pair_pattern' || p.type === 'pair') {
                const key = p.childForFieldName('key');
                const val = p.childForFieldName('value');
                if (key && val) {
                  specifiers.push({ imported: key.text, local: val.text, isTypeOnly: false });
                  addUsedIdentifier(val.text);
                }
              }
            }
          }
        }

        if (node.parent?.type === 'member_expression' && node.parent.parent?.type === 'variable_declarator') {
          const local = node.parent.parent.childForFieldName('name');
          const property = node.parent.childForFieldName('property');
          if (local?.type === 'identifier' && property?.type === 'property_identifier') specifiers = [{ imported: property.text, local: local.text, isTypeOnly: false }];
        }
        imports.push({
          source,
          specifiers,
          isDynamic: false,
          kind: 'cjs',
          isTopLevel: isModuleTopLevel(node),
          byteOffset: byteOffset(node),
          range: toRange(node),
        });
      } else if (functionNode && functionNode.text === 'import' && argsNode?.firstNamedChild?.type === 'string') {
        // Dynamic import()
        imports.push({
          source: stripQuotes(argsNode.firstNamedChild.text),
          specifiers: [],
          isDynamic: true,
          kind: 'esm',
          range: toRange(node),
        });
      } else if (functionNode) {
        // Normal function/method call
        let syntaxKind = 'direct_call';
        let calleeName = functionNode.text;

        if (functionNode.type === 'member_expression') {
          syntaxKind = 'method_call';
          const property = functionNode.childForFieldName('property');
          if (property) calleeName = property.text;
        }

        const callRange = toRange(node);
        callSites.push({
          calleeName,
          receiver: functionNode.type === 'member_expression' ? (functionNode.childForFieldName('object')?.text ?? null) : null,
          requireSource: functionNode.type === 'member_expression' && functionNode.childForFieldName('object')?.type === 'call_expression' && functionNode.childForFieldName('object')?.childForFieldName('function')?.text === 'require' && functionNode.childForFieldName('object')?.childForFieldName('arguments')?.firstNamedChild?.type === 'string' ? stripQuotes(functionNode.childForFieldName('object').childForFieldName('arguments').firstNamedChild.text) : null,
          computed: functionNode.type === 'subscript_expression',
          endByte: byteOffset(node) + Buffer.byteLength(node.text, 'utf8'),
          optional: isOptionalCall(node),
          byteOffset: byteOffset(node),
          syntaxKind,
          range: callRange,
          enclosingSymbolKey: currentEnclosingSymbolKey(),
          confidence: hasErrorOverlap(callRange) ? 'low' : 'high',
        });

        // Value references: check arguments passed to calls (e.g. callback functions)
        if (argsNode) {
          function collectArgIdentifiers(curr) {
            if (!curr) return;
            if (curr.type === 'identifier') {
              valueReferences.push({
                identifier: curr.text,
                byteOffset: byteOffset(curr),
                enclosingSymbolKey: currentEnclosingSymbolKey(),
                range: toRange(curr),
              });
            }
            for (let i = 0; i < curr.childCount; i++) {
              collectArgIdentifiers(curr.child(i));
            }
          }
          for (let i = 0; i < argsNode.childCount; i++) {
            collectArgIdentifiers(argsNode.child(i));
          }
        }
      }
    }

    // New expression (new Foo())
    if (node.type === 'new_expression') {
      const constructorNode = node.childForFieldName('constructor') || node.child(1);
      if (constructorNode) {
        const newRange = toRange(node);
        callSites.push({
          calleeName: constructorNode.text,
          byteOffset: byteOffset(node),
          syntaxKind: 'new_expression',
          range: newRange,
          enclosingSymbolKey: currentEnclosingSymbolKey(),
          confidence: hasErrorOverlap(newRange) ? 'low' : 'high',
        });
      }
    }

    // JSX usage
    if (node.type === 'jsx_element' || node.type === 'jsx_self_closing_element') {
      const opening = node.type === 'jsx_element' ? node.childForFieldName('open_tag') || node.child(0) : node;
      const tagNode = opening ? (opening.childForFieldName('name') || opening.children.find((c) => c.type === 'identifier' || c.type === 'nested_identifier' || c.type === 'jsx_identifier')) : null;
      if (tagNode) {
        jsxUsages.push({
          elementName: tagNode.text,
          byteOffset: byteOffset(node),
          enclosingSymbolKey: currentEnclosingSymbolKey(),
          range: toRange(node),
        });
      }
    }

    // JSX attribute value references (e.g. onClick={handleClick} or user={user})
    if (node.type === 'jsx_attribute') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child.type === 'jsx_expression') {
          for (let j = 0; j < child.childCount; j++) {
            const expChild = child.child(j);
            if (expChild.type === 'identifier') {
              valueReferences.push({
                identifier: expChild.text,
                byteOffset: byteOffset(expChild),
                enclosingSymbolKey: currentEnclosingSymbolKey(),
                range: toRange(expChild),
              });
            }
          }
        }
      }
    }

    // Class declaration
    if (node.type === 'class_declaration' || (node.type === 'class' && node.isNamed)) {
      const nameNode = node.childForFieldName('name');
      const name = nameNode ? nameNode.text : 'AnonymousClass';
      const bodyNode = node.childForFieldName('body');
      const exportCtx = checkExportContext(node);
      const exportedNames = exportCtx.isExported ? [exportCtx.isDefault ? 'default' : name] : [];

      if (exportCtx.isExported) {
        exports.push({
          name: exportCtx.isDefault ? 'default' : name,
          local: name,
          isTypeOnly: false,
          reexportSource: null,
          range: toRange(node),
        });
      }

      const classSymbolKey = addSymbol({
        name,
        kind: 'class',
        node,
        bodyNode,
        exportedNames,
      });

      // Class heritage (extends / implements)
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child.type === 'class_heritage') {
          for (let j = 0; j < child.childCount; j++) {
            const h = child.child(j);
            if (h.type === 'extends_clause') {
              const target = h.childForFieldName('value') || h.children.find((c) => c.type === 'identifier');
              if (target) {
                extendsImplements.push({
                  classSymbolKey,
                  targetName: target.text,
                  type: 'extends',
                });
              }
            } else if (h.type === 'implements_clause') {
              for (let k = 0; k < h.childCount; k++) {
                const typeChild = h.child(k);
                if (typeChild.type === 'type_identifier' || typeChild.type === 'identifier') {
                  extendsImplements.push({
                    classSymbolKey,
                    targetName: typeChild.text,
                    type: 'implements',
                  });
                }
              }
            }
          }
        }
      }

      symbolStack.push(classSymbolKey);
      scopeStack.push(`class:${name}`);
      for (let i = 0; i < node.childCount; i++) walk(node.child(i));
      scopeStack.pop();
      symbolStack.pop();
      return;
    }

    // Interface declaration
    if (node.type === 'interface_declaration') {
      const nameNode = node.childForFieldName('name');
      const name = nameNode ? nameNode.text : 'AnonymousInterface';
      const bodyNode = node.childForFieldName('body');
      const exportCtx = checkExportContext(node);
      const exportedNames = exportCtx.isExported ? [exportCtx.isDefault ? 'default' : name] : [];

      if (exportCtx.isExported) {
        exports.push({
          name: exportCtx.isDefault ? 'default' : name,
          local: name,
          isTypeOnly: true,
          reexportSource: null,
          range: toRange(node),
        });
      }

      const interfaceSymbolKey = addSymbol({
        name,
        kind: 'interface',
        node,
        bodyNode,
        exportedNames,
      });

      symbolStack.push(interfaceSymbolKey);
      scopeStack.push(`interface:${name}`);
      for (let i = 0; i < node.childCount; i++) walk(node.child(i));
      scopeStack.pop();
      symbolStack.pop();
      return;
    }

    // Type alias declaration
    if (node.type === 'type_alias_declaration') {
      const nameNode = node.childForFieldName('name');
      const name = nameNode ? nameNode.text : 'AnonymousType';
      const valueNode = node.childForFieldName('value');
      const exportCtx = checkExportContext(node);
      const exportedNames = exportCtx.isExported ? [exportCtx.isDefault ? 'default' : name] : [];

      if (exportCtx.isExported) {
        exports.push({
          name: exportCtx.isDefault ? 'default' : name,
          local: name,
          isTypeOnly: true,
          reexportSource: null,
          range: toRange(node),
        });
      }

      addSymbol({
        name,
        kind: 'type_alias',
        node,
        bodyNode: valueNode,
        exportedNames,
      });

      for (let i = 0; i < node.childCount; i++) walk(node.child(i));
      return;
    }

    // Enum declaration
    if (node.type === 'enum_declaration') {
      const nameNode = node.childForFieldName('name');
      const name = nameNode ? nameNode.text : 'AnonymousEnum';
      const bodyNode = node.childForFieldName('body');
      const exportCtx = checkExportContext(node);
      const exportedNames = exportCtx.isExported ? [exportCtx.isDefault ? 'default' : name] : [];

      if (exportCtx.isExported) {
        exports.push({
          name: exportCtx.isDefault ? 'default' : name,
          local: name,
          isTypeOnly: false,
          reexportSource: null,
          range: toRange(node),
        });
      }

      addSymbol({
        name,
        kind: 'enum',
        node,
        bodyNode,
        exportedNames,
      });

      for (let i = 0; i < node.childCount; i++) walk(node.child(i));
      return;
    }

    // Function declaration
    if (node.type === 'function_declaration' || node.type === 'generator_function_declaration') {
      const nameNode = node.childForFieldName('name');
      const name = nameNode ? nameNode.text : 'anonymous';
      const paramsNode = node.childForFieldName('parameters');
      const bodyNode = node.childForFieldName('body');
      const returnTypeNode = node.childForFieldName('return_type');
      const exportCtx = checkExportContext(node);
      const exportedNames = exportCtx.isExported ? [exportCtx.isDefault ? 'default' : name] : [];

      if (exportCtx.isExported) {
        exports.push({
          name: exportCtx.isDefault ? 'default' : name,
          local: name,
          isTypeOnly: false,
          reexportSource: null,
          range: toRange(node),
        });
      }

      const functionSymbolKey = addSymbol({
        name,
        kind: 'function',
        node,
        paramsNode,
        bodyNode,
        returnTypeNode,
        exportedNames,
      });

      symbolStack.push(functionSymbolKey);
      scopeStack.push(`function:${name}`);
      for (let i = 0; i < node.childCount; i++) walk(node.child(i));
      scopeStack.pop();
      symbolStack.pop();
      return;
    }

    // Method definition in class (methods, getters, setters)
    if (node.type === 'method_definition') {
      const nameNode = node.childForFieldName('name');
      const name = nameNode ? nameNode.text : 'anonymousMethod';
      const paramsNode = node.childForFieldName('parameters');
      const bodyNode = node.childForFieldName('body');
      const returnTypeNode = node.childForFieldName('return_type');

      let kind = 'method';
      for (let i = 0; i < node.childCount; i++) {
        const text = node.child(i).text;
        if (text === 'get') { kind = 'getter'; break; }
        if (text === 'set') { kind = 'setter'; break; }
      }

      const methodSymbolKey = addSymbol({
        name,
        kind,
        node,
        paramsNode,
        bodyNode,
        returnTypeNode,
        exportedNames: [],
      });

      symbolStack.push(methodSymbolKey);
      scopeStack.push(`${kind}:${name}`);
      for (let i = 0; i < node.childCount; i++) walk(node.child(i));
      scopeStack.pop();
      symbolStack.pop();
      return;
    }

    // Anonymous or callback functions (e.g. in map/forEach or callbacks)
    if ((node.type === 'arrow_function' || node.type === 'function_expression') &&
        node.parent?.type !== 'variable_declarator' && node.parent?.type !== 'method_definition') {
      const nameNode = node.childForFieldName('name');
      const name = nameNode ? nameNode.text : 'anonymous';
      const paramsNode = node.childForFieldName('parameters');
      const bodyNode = node.childForFieldName('body');
      const returnTypeNode = node.childForFieldName('return_type');

      const callbackSymbolKey = addSymbol({
        name,
        kind: node.type === 'arrow_function' ? 'arrow_function' : 'function',
        node,
        paramsNode,
        bodyNode,
        returnTypeNode,
        exportedNames: [],
      });

      symbolStack.push(callbackSymbolKey);
      scopeStack.push(`function:${name}`);
      for (let i = 0; i < node.childCount; i++) walk(node.child(i));
      scopeStack.pop();
      symbolStack.pop();
      return;
    }

    // Variable declarator (const foo = () => ... or const bar = 123)
    if (node.type === 'variable_declarator') {
      const nameNode = node.childForFieldName('name');
      const valueNode = node.childForFieldName('value');
      const name = nameNode ? nameNode.text : null;
      if (nameNode?.type === 'identifier') {
        const constructorNode = valueNode?.type === 'new_expression' ? valueNode.childForFieldName('constructor') : null;
        const annotation = node.childForFieldName('type')?.namedChildren?.find((child) => child.type === 'type_identifier');
        const typeName = constructorNode?.type === 'identifier' ? constructorNode.text : annotation?.text;
        if (typeName) typeBindings.push({ name, typeName, exactNew: Boolean(constructorNode) && node.parent?.text?.startsWith('const '), enclosingSymbolKey: currentEnclosingSymbolKey() });
      }

      if (nameNode?.type === 'identifier' && (!valueNode || !['arrow_function', 'function_expression'].includes(valueNode.type))) {
        const exportCtx = checkExportContext(node);
        const exportedNames = exportCtx.isExported ? [name] : [];
        if (exportCtx.isExported) exports.push({ name, local: name, isTypeOnly: false, reexportSource: null, range: toRange(node) });
        addSymbol({ name, kind: 'variable', node, bodyNode: valueNode, exportedNames });
      }

      if (name && valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')) {
        const paramsNode = valueNode.childForFieldName('parameters') || valueNode.childForFieldName('parameter');
        const singleParam = valueNode.childForFieldName('parameter');
        if (singleParam?.type === 'identifier') uncertainBindings.add(singleParam.text);
        const bodyNode = valueNode.childForFieldName('body');
        const returnTypeNode = valueNode.childForFieldName('return_type');
        const exportCtx = checkExportContext(node);
        const exportedNames = exportCtx.isExported ? [exportCtx.isDefault ? 'default' : name] : [];

        if (exportCtx.isExported) {
          exports.push({
            name: exportCtx.isDefault ? 'default' : name,
            local: name,
            isTypeOnly: false,
            reexportSource: null,
            range: toRange(node),
          });
        }

        const variableSymbolKey = addSymbol({
          name,
          kind: valueNode.type === 'arrow_function' ? 'arrow_function' : 'function',
          node,
          paramsNode,
          bodyNode,
          returnTypeNode,
          exportedNames,
        });

        symbolStack.push(variableSymbolKey);
        scopeStack.push(`function:${name}`);
        for (let i = 0; i < valueNode.childCount; i++) walk(valueNode.child(i));
        scopeStack.pop();
        symbolStack.pop();
        return;
      }
    }

    // Recurse on children
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i));
    }
  }

  walk(rootNode);
  for (const symbol of symbols) {
    if (symbol.scope !== 'global' || symbol.enclosingSymbolKey) continue;
    const names = exports.filter((entry) => !entry.reexportSource && !entry.isTypeOnly && entry.local === symbol.name).map((entry) => entry.name);
    symbol.exportedNames = [...new Set([...symbol.exportedNames, ...names])].sort();
  }
  if ((cjsObjectWrites || cjsAliasWrites) && (cjsShadowedGlobal || symbols.some((symbol) => ['module', 'exports'].includes(symbol.name)))) bindingEvidenceComplete = false;

  const parseStatus = diagnostics.length > 0 ? (rootNode.childCount === 0 ? 'error' : 'partial') : 'complete';

  const clean = (value) => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
    return value;
  };
  return clean({
    path: filePath,
    language,
    symbols,
    imports,
    exports,
    callSites,
    jsxUsages,
    valueReferences,
    extendsImplements,
    usedIdentifiers: Array.from(usedIdentifiers).sort(),
    uncertainBindings: Array.from(uncertainBindings).sort(),
    typeBindings,
    riskSignals,
    bindingEvidenceVersion: bindingEvidenceComplete ? 1 : null,
    diagnostics,
    parseStatus,
  });
}
