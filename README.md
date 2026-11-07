# Mesa Card Club

Tongits, Texas Hold'em and Blackjack in the browser, with friends. No install step: only Node.js 18+.

```bash
npm start        # http://localhost:3000
npm run check    # rule tests + thousands of simulated bot rounds
```

- Sign up with a Gmail address and a password. Every new account starts with **1,000 coins**. A daily bonus gives +100 every 24h.
- **Create a table** (pick the game and a bet of 10/50/100) and share the 4-letter code. Friends enter it under **Join a friend**.
- Empty seats are filled with bots, so you can play alone too. Tongits always has 3 seats.
- Each player gets 30 seconds per move. When the time runs out, a safe move is made for them (in Poker: check or fold, in Blackjack: stand).
- If someone leaves mid-round, a bot finishes their hand and they still win or lose that round.

## Payouts
| Game | Rules |
|------|-------|
| Tongits | Each loser pays the bet to the winner. Tongits (empty hand) pays ×2. When the stock runs out, players with no meld are *burned* and pay ×2. |
| Poker | Bet = big blind. You sit with up to 50 big blinds of your coins. One hand per round, side pots handled. |
| Blackjack | Win 1:1, blackjack 3:2, double down allowed, no split. Dealer stands on 17. |

## Playing over the internet
`localhost` only works on your own computer. Friends on the **same Wi-Fi** can open `http://<your PC's IP>:3000`
(find it with `ipconfig`; Windows Firewall may ask to allow Node). For friends anywhere, deploy the folder to a
Node host (Render, Railway, a VPS) and run `npm start`; it reads `PORT` from the environment.

## Publishing on Render (free)
`render.yaml` sets everything up: on render.com choose **New → Blueprint** and pick this GitHub repo.
- The admin key for `/admin` is the `ADMIN_KEY` value under the service's **Environment** tab.
- Free plan: the site sleeps after 15 minutes without visitors (the next visit takes about a minute to wake it),
  and it has no disk. To keep accounts, coins and logins, create a free database at https://console.upstash.com
  (Redis → Create database), then copy its **UPSTASH_REDIS_REST_URL** and **UPSTASH_REDIS_REST_TOKEN** into the
  Render service's **Environment** tab. Without them, accounts reset whenever the site sleeps or redeploys.
- If the database can't be reached at startup, the server refuses to start rather than starting empty,
  so saved accounts are never overwritten. Check the Render logs and the two values if the site won't come up.

## Files
- `server.js`: accounts, sessions, tables, live updates (Server-Sent Events), bots and the turn timer.
- `games/*.js`: the rules of each game (`start`, `act`, `view`, `botAct`). Hands are hidden server-side.
- `public/`: the web page.
- `data/users.json`: accounts and coins (created on first sign-up; passwords stored as scrypt hashes).
