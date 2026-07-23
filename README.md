# D. Social App 

A decentralized social media proof-of-concept built with React, TypeScript, and a browser Helia (IPFS) node.

## I have an identity, what now?

-> Join a Social Network with it OR just use it for blogging. 

You can find the latest version of D. Social App here: https://ipfs.io/ipns/k51qzi5uqu5dl65eg14adz5ceu6k9dna2s55io6iyr1qpyd1wwxqf2g7wm3tf8

## You want to contribute?

-> Read the [spec.md](spec.md)

## Getting Started

1.  **Install Dependencies:**
    ```bash
    npm install
    # or
    yarn install
    ```

2.  **Run Development Server:**
    ```bash
    npm run dev
    ```
    This will start the Vite development server, typically at `http://localhost:5173`.

    **Helia (browser IPFS):** The app runs a full browser Helia node for identity (keychain),
    content add/pin, and IPNS publish. No local Kubo node is required. Watch the console for
    `[Helia] Browser node ready`.

3.  **Build for Production:**
    ```bash
    npm run build
    ```
    This creates a `dist` folder with the optimized production build.

## Key Technologies

* React
* TypeScript
* Vite
* React Router DOM
* React Hot Toast (for notifications)
* React Responsive Masonry (for space efficient feed rendering)
* Helia (browser IPFS for storage and identity)


## TODO
- following not possible when on public gateway hosted url
- loggout on refresh bug - should stay logged in
- allow creating user aliases
- export/import of user's private key
- moderator features / filter disliked posts of followed users in the role of moderators
- scale through users - the more users cache (view) and pin (like) content, the faster the network will become.
- wire Helia gossipsub for peer presence (explore still works without it)
