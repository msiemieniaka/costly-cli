# Price validation

Checked 2026-11-11. No AWS account or bill was used.

The [AWS pricing page](https://aws.amazon.com/bedrock/pricing/) was checked, but its rendered Anthropic table was not available in the text response. The authoritative [AWS us-east-1 price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/us-east-1/index.json) was downloaded locally: version `20261109224312`, published `2026-11-09T22:43:12Z`.

The checked override covers **Claude Sonnet 4.6, standard on-demand, us-east-1**, global or US geographic cross-region inference. It does not assert prices for other regions, batch, priority, reserved throughput, long-context premiums, or discounts.

| USD per million tokens | Global | US geographic |
|---|---:|---:|
| Input | 3 | 3.3 |
| Output | 15 | 16.5 |
| Cache read | 0.3 | 0.33 |
| Cache write, 5 minutes | 3.75 | 4.125 |
| Cache write, 1 hour | 6 | 6.6 |

AWS SKU evidence, global / geographic respectively:

- Input: `4BCSX42248MW35W4` / `KPFGPZJ8VWMREGAV`
- Output: `CMWTKXQCAJ2T8A4U` / `GMB9AQ5DYNAGYZEC`
- Cache read: `R2P3DDR9MM8SVY24` / `2459RQS6BSFATF92`
- Cache write: `77BN6999TPFX9ZBM` / `UZUVWF3P26ENQTZ8`
- Cache write 1h: `2TXXPHUXEQ3T5476` / `Q5UDFRBQA4X5VSXR`

Model profile format is corroborated by [AWS's Bedrock integration example](https://builder.aws.com/content/3Ex2TtcjcDE2OW6n7Iy2oH7CiBz/integrate-claude-with-aws-bedrock). Region comes from the detected tool settings / AWS_REGION. Missing region does not select these regional overrides.

`tests/bedrock.test.ts` checks 1M input, 200k output, 500k cache reads, 100k five-minute writes and 100k one-hour writes: **$7.125 global**, **$7.8375 geographic**. The latter is 10% higher in this AWS price list.

Other models use the [LiteLLM public price list](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json), cached daily, with a bundled subset for offline startup. These are estimates, not independently AWS-verified prices. Every record retains its price-table version. Missing model/tier rates are explicitly unpriced; unknown is never labelled free. Local-model usage is zero. Subscription estimates represent API-equivalent usage, not subscription invoices.

Source-code reading and real-history comparison are described in `validation.md`. Price correctness against an actual AWS bill remains outside this PoC.
