# Changelog

## 0.3.2

- New tool `check_numbers`: start a number check from a short list, or read one by `job_id`. It is registered without `GATEWAY_ALLOW_SEND` because it sends no message. Checks run in the background, spaced out, on non-sandbox channels for accounts with an active non-sandbox channel.
- SDK floor raised to ^1.32.2.

## 0.3.1

- HelloHop MCP server, published as hellohop-mcp.
- Default API URL: https://api.hellohop.app/v1.
- MCP Registry name: app.hellohop/hellohop.
