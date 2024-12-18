# AI Assistant on your Linear app - PromptQL

## How to run

1. [Install DDN CLI](https://promptql.hasura.io/docs/installation)
2. Clone this repo
3. `cp .env.example .env`
4. Add Linear API Key as env var `LINEAR_API_KEY` in file `.env`. More info on Linear API Keys at https://developers.linear.app/docs/graphql/working-with-the-graphql-api#personal-api-keys
5. Add Anthropic API Key as env var `ANTHROPIC_API_KEY` in file `.env`
6. Setup DDN project: `ddn project init`
7. Build supergraph `ddn supergraph build local`
8. Run Promptql locally: `ddn run docker-start`
