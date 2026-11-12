---
title: Privacy
description: What chessmoments stores about visitors, tournament organisers and the players in its games database, and how to ask for a correction or removal.
showInMenu: false
menuOrder: 100
---

chessmoments is a free, non-commercial chess site run by a private individual. This page explains what the site stores and why. For questions, corrections and removal requests, write to **[privacy@chessmoments.com](mailto:privacy@chessmoments.com)**.

## Visiting the site

- **No accounts, no ads, no cookies.** Public pages set no cookies. The only cookie the site uses is the sign-in cookie on the site owner's admin page.
- **Analytics:** [Cloudflare Web Analytics](https://www.cloudflare.com/web-analytics/) counts page views without cookies and without following you from site to site.
- **Hosting:** the site runs on Cloudflare, which needs your IP address and browser details to deliver each page and to protect the site from abuse. Our request logs there are deleted after a few days.
- **Rate limits:** to keep the games database and the engine available, requests are counted per IP address for one minute at a time. These counters are not stored by us.
- **Settings in your browser:** your board style, chess clock settings and daily puzzle results are kept in your browser's local storage (`cm-board`, `cm-clock`, `cm-puzzle-results`). They never leave your device. Clear the site's data in your browser to remove them.

## Players in the games database

- The games come from [The Week in Chess](https://theweekinchess.com/) (TWIC), used with Mark Crowther's permission, and from tournaments uploaded by their organisers.
- Player pages show what the game records contain: name, title, rating at the time, FIDE ID where it is given, and the games and results. Tournament results are public in chess, and players, organisers and fans want to look them up. That interest is why we publish them.
- If something about you is wrong, or you want a game or your player page taken down, write to us and include the page address. We usually correct or remove it within a week. Mistakes in TWIC data can come back with a later import, so we also make sure they stay fixed.

## Engine analysis and AI notes

- **Analyse with Stockfish** sends the game's moves to our own engine server. The result is stored with the game and shown to everyone.
- **Write notes with AI** sends the game (moves, the players' names and ratings, the event and its standings) and the stored analysis to Anthropic's [Claude](https://www.anthropic.com/claude), which writes a summary and notes on key moves. The notes are stored with the game and shown to everyone. Nothing about the visitor who asked is sent. The notes are written by a machine and can contain mistakes. Tell us if one is wrong or unfair, and we will remove it.

## Uploading a tournament

- When you create a tournament at [/upload/](/upload/), we store what you enter: the tournament's name, place and format, the optional name or email address you give us in case we have a question, and the PGN files you upload.
- Your contact details are seen only by the site owner and are never published. To limit how many tournaments one address can create, we store a one-way hash of your IP address with the tournament, not the address itself.
- The games in your files are published once we approve the tournament. Upload only games you may publish. If a player asks for their games to be removed, we remove them.
- We keep all of this while the tournament is on the site or waiting for review. Ask us at any time, and we will delete the tournament with its files, your contact details and the hash. Its secret link then stops working.

## Your rights

You can ask what we hold about you, and have it corrected or deleted. You can also object to its use, or ask for a copy. Write to [privacy@chessmoments.com](mailto:privacy@chessmoments.com). Deleted data disappears from our backups within about six weeks. If you are not satisfied with our answer, you can complain to the data protection authority in your country.

[About chessmoments](/about/) · [Credits](/credits/)
