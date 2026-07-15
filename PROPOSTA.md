# Claude Usage Bar — proposta final de interface

## Windows

O indicador seguirá o formato do screenshot: dois widgets horizontais lado a lado, cada um com duas linhas.

```text
┌ Session 10% · 16:11 ┐  ┌ Weekly 63% · 16:11 ┐
  Reset in 4 hours 28      Reset in 3 days 14 hours
```

A primeira linha é o segmento colorido do widget; a segunda linha permanece no fundo escuro e informa o reset em inglês. Não haverá ícone “C” nem abreviações como `Sem`.

## macOS

Haverá os mesmos dois widgets, mas cada um será reduzido a uma única linha para caber na barra de menus:

```text
● Session 10% · 16:11 · Reset in 4 hours 28 minutes
● Weekly 63% · 16:11 · Reset in 3 days 14 hours
```

Os pontos coloridos identificam os dois indicadores sem ocupar a altura de um ícone separado; não haverá segunda linha no macOS.

## Configurações

A tela de configurações terá:

- dois sliders para os limites entre as zonas (`Red / Yellow boundary` e `Yellow / Green boundary`);
- uma barra segmentada que atualiza imediatamente com os valores dos sliders;
- o exemplo inicial do screenshot: vermelho abaixo de 30%, amarelo entre 30% e 70% e verde acima de 70%;
- `Show monthly limit`, desligado por padrão.

O limite mensal aparecerá somente na janela de detalhes/popover, nunca dentro do widget compacto.

## i18n

O protótipo e os textos da primeira versão serão em inglês, com catálogo `en-US` e estrutura pronta para `pt-BR`; labels, tooltips, estados, unidades de tempo e mensagens de erro serão chaves de tradução, não strings espalhadas pelo código.

## Arquitetura proposta

- Electron para o processo principal, autenticação, chamadas ao Claude.ai, armazenamento seguro e configurações.
- `preload` com context isolation.
- Windows: dois elementos compactos associados à barra de tarefas/bandeja, preservando as duas linhas.
- macOS 12+: dois `NSStatusItem` em uma linha cada, com popover para detalhes.
- Builds Windows x64/arm64 e macOS x64/arm64.

Este documento e o protótipo visual representam somente a proposta; a implementação do app ainda não foi iniciada.
