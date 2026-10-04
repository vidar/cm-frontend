/** The site's tools, shared by the homepage grid and /llms.txt. */
export const TOOLS = [
  {
    href: '/puzzle/',
    name: 'Daily chess puzzle',
    blurb: 'A new puzzle from a real game every day. Keep your streak and share your result.',
    agent: 'Today\'s puzzle as JSON: /puzzle/today.json (or /puzzle/YYYY-MM-DD.json). Archive: /puzzle/archive/',
  },
  {
    href: '/openings/',
    name: 'Chess openings',
    blurb: 'Every named opening line with Lichess statistics, engine evaluation, best replies and a board diagram.',
    agent: 'One page per line at /openings/<slug>/ (games, win/draw/loss by rating, most played replies, Stockfish eval, example games); index with stats as JSON at /openings.json',
  },
  {
    href: '/games/',
    name: 'Games database',
    blurb: 'Millions of over-the-board games since 2012: search players, browse tournaments, replay any game.',
    agent: 'Game pages /games/<id>-<slug>/ (moves + PGN in the HTML), player pages /players/<slug>/ (?color=w|b, ?page=N), event pages /events/<slug>/, player search /players/?q=<name>. Source: The Week in Chess, used with permission (no bulk export).',
  },
  {
    href: '/analysis/',
    name: 'Analysis board',
    blurb: 'Analyse any position or game with Stockfish in your browser, with variations and PGN export.',
    agent: 'Open a position: /analysis/?fen=<FEN> (spaces may be "_"), or a game: /analysis/?pgn=<SAN moves>, optional &flip=1. Engine runs client-side.',
  },
  {
    href: '/board-image/',
    name: 'Board image generator',
    blurb: 'Turn a FEN or PGN into a chess diagram you can embed anywhere.',
    agent: 'SVG API: /board.svg?fen=<FEN>&flip=1&lastmove=e2e4&highlight=d5,f7&size=400&coords=0',
  },
  {
    href: '/chess-clock/',
    name: 'Chess clock',
    blurb: 'A full-screen clock for over-the-board games, with increment and delay.',
    agent: 'Interactive browser tool (no API).',
  },
  {
    href: '/coordinates-trainer/',
    name: 'Coordinates trainer',
    blurb: 'Find as many squares as you can in 30 seconds. Learn the board from both sides.',
    agent: 'Interactive browser tool (no API).',
  },
];
