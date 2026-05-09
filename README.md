# The Webrewind

![Build Status](https://img.shields.io/badge/build-passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-1.0.0-orange)

Rewinding the evolution of your website.

## Overview

The Webrewind is a tool designed to help developers and designers track and visualize the changes made to a website over time. It provides a comprehensive view of the website's evolution, making it easier to understand the impact of each change.

## Features

- Visualize website changes over time
- Track modifications in design and content
- Easy integration with existing projects

## Screenshot

![Webrewind Screenshot](apps/client/public/screely-1736442296819.png)

# Project Structure

Turborepo + Yarn workspaces monorepo.

```bash
webrewind/
├── apps/
│   ├── client/     # Vite + React + TS  (@webrewind/client)
│   └── server/     # Express + Puppeteer (@webrewind/server)
├── turbo.json      # pipeline config
├── package.json    # root workspace config
├── .gitignore
├── README.md
└── yarn.lock
```

## Getting Started

### Prerequisites

- Node.js (>= 14.x)
- npm (>= 6.x)

### Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/iamspathan/webrewind.git
   cd The-Webrewind
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

### Running Locally

1. Start both client and server via Turborepo:

   ```bash
   yarn dev
   ```

2. Open your browser and navigate to `http://localhost:5173` for the client. The server runs on `http://localhost:3200`.

### Useful scripts

- `yarn dev` — run all apps in dev mode (turbo)
- `yarn build` — build all apps
- `yarn lint` — lint all apps
- `yarn workspace @webrewind/client dev` — run just the client
- `yarn workspace @webrewind/server dev` — run just the server

## Contributing

Contributions are welcome! Please read the [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
