# Unicorn Pocket

A small, no-backend Progressive Web App: upload a chat screenshot, pick a tone,
and get three copy-paste reply options.

The browser calls the Anthropic API directly. Your API key and voice settings
stay on your device (`localStorage`) and are never sent anywhere except Anthropic,
on your own key. No server, no accounts, no tracking.

The API key is origin-scoped — serve this only from an origin you control.
