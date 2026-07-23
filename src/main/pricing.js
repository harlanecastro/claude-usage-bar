'use strict';

/**
 * Custo "estimado" a partir das tarifas CONFIGURADAS pelo usuário (Configurações
 * → Custo estimado): um preço de ENTRADA e um de SAÍDA em USD por MTok, aplicados
 * a TODOS os modelos — o transcript local só traz tokens, não valor. Sem tabela
 * fixa por modelo: se trocar de modelo, o usuário atualiza os dois campos. Regras
 * da API mantidas: cache-write = 1,25× o preço de entrada; cache-read = 0,1×.
 *
 * `rates` = { inputPerMTok, outputPerMTok }. Retorna { costUsd, hypotheticalUsd,
 * priced } — o custo HIPOTÉTICO é tudo a preço cheio de entrada (a distância até
 * costUsd é a economia de cache); priced=false quando não há preço configurado.
 */
function costFor(rates, { inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0 }) {
  const input = Number(rates?.inputPerMTok) || 0;
  const output = Number(rates?.outputPerMTok) || 0;
  const priced = input > 0 || output > 0;
  const per = 1 / 1_000_000;
  const costUsd = (inputTokens * input
    + cacheCreationTokens * input * 1.25
    + cacheReadTokens * input * 0.1
    + outputTokens * output) * per;
  const hypotheticalUsd = ((inputTokens + cacheCreationTokens + cacheReadTokens) * input
    + outputTokens * output) * per;
  return { costUsd, hypotheticalUsd, priced };
}

module.exports = { costFor };
