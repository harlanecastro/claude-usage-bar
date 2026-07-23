'use strict';

/**
 * Custo "estimado" a partir das tarifas CONFIGURADAS pelo usuário (Configurações
 * → Custo estimado): preços de ENTRADA, SAÍDA e prompt caching (ESCRITA/LEITURA)
 * em USD por MTok, aplicados a TODOS os modelos — o transcript local só traz
 * tokens, não valor. Sem tabela fixa por modelo: se trocar de modelo, o usuário
 * atualiza os campos.
 *
 * `rates` = { inputPerMTok, outputPerMTok, cacheWritePerMTok, cacheReadPerMTok }.
 * Retorna as 4 PARCELAS (inputUsd/outputUsd/cacheWriteUsd/cacheReadUsd) + o total
 * (costUsd, soma delas) + o custo HIPOTÉTICO (tudo a preço cheio de entrada — a
 * distância até costUsd é a economia de cache) + priced (false = sem preço).
 */
function costFor(rates, { inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0 }) {
  const input = Number(rates?.inputPerMTok) || 0;
  const output = Number(rates?.outputPerMTok) || 0;
  const cacheWrite = Number(rates?.cacheWritePerMTok) || 0;
  const cacheRead = Number(rates?.cacheReadPerMTok) || 0;
  const priced = input > 0 || output > 0;
  const per = 1 / 1_000_000;
  const inputUsd = inputTokens * input * per;
  const outputUsd = outputTokens * output * per;
  const cacheWriteUsd = cacheCreationTokens * cacheWrite * per;
  const cacheReadUsd = cacheReadTokens * cacheRead * per;
  const costUsd = inputUsd + outputUsd + cacheWriteUsd + cacheReadUsd;
  const hypotheticalUsd = ((inputTokens + cacheCreationTokens + cacheReadTokens) * input
    + outputTokens * output) * per;
  return { costUsd, inputUsd, outputUsd, cacheWriteUsd, cacheReadUsd, hypotheticalUsd, priced };
}

module.exports = { costFor };
