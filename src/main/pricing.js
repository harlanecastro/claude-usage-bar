'use strict';

/**
 * Tabela ESTÁTICA de preços por família de modelo (USD por MTok) — o app não
 * tem o custo real dos registros locais, então o dashboard exibe custo
 * "estimado" (rotulado assim na UI). Regras da API: cache-write = 1,25× o
 * preço de entrada; cache-read = 0,1×. Modelo fora da tabela → custo 0 (a
 * economia em TOKENS continua correta e é a métrica primária no Local).
 */
const FAMILIES = [
  { match: /opus|fable|mythos/, input: 15, output: 75 },
  { match: /sonnet/, input: 3, output: 15 },
  { match: /haiku/, input: 1, output: 5 },
];

function familyFor(model) {
  const name = String(model || '').toLowerCase();
  return FAMILIES.find((family) => family.match.test(name)) || null;
}

/**
 * Custo estimado de um agregado {inputTokens, outputTokens, cacheReadTokens,
 * cacheCreationTokens} de UM modelo, e o custo HIPOTÉTICO sem cache (tudo a
 * preço cheio de entrada) — a distância entre os dois é a economia de cache.
 * Retorna { costUsd, hypotheticalUsd, priced } (priced=false = modelo fora da
 * tabela, custos zerados).
 */
function costFor(model, { inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0 }) {
  const family = familyFor(model);
  if (!family) return { costUsd: 0, hypotheticalUsd: 0, priced: false };
  const per = 1 / 1_000_000;
  const costUsd = (inputTokens * family.input
    + cacheCreationTokens * family.input * 1.25
    + cacheReadTokens * family.input * 0.1
    + outputTokens * family.output) * per;
  const hypotheticalUsd = ((inputTokens + cacheCreationTokens + cacheReadTokens) * family.input
    + outputTokens * family.output) * per;
  return { costUsd, hypotheticalUsd, priced: true };
}

module.exports = { costFor, familyFor };
