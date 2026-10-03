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
    blurb: 'Every named opening line with moves, ECO code, FEN and a board diagram.',
    agent: 'One page per line at /openings/<slug>/; full index as JSON at /openings.json',
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
