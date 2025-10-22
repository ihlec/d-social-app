# D. Social App 

A decentralized social media proof-of-concept application built with React, TypeScript, and integrating with IPFS (via Kubo or Filebase).

## I have a IPFS node, what now?

-> Join a Social Network with it OR just use it for blogging. 

## Getting Started

1.  **Install Dependencies:**
    ```bash
    npm install
    # or
    yarn install
    ```

2.  **Set up Environment (if needed):**
    * Ensure you have access to a Kubo node (if using Kubo login) or Filebase credentials.
    * Configure CORS settings for your Filebase bucket or Kubo API endpoint as required by the application logic.

3.  **Run Development Server:**
    ```bash
    npm run dev
    ```
    This will start the Vite development server, typically at `http://localhost:5173`.

4.  **Build for Production:**
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
* React Virtuoso (for efficient list rendering)
* IPFS / Filebase (for decentralized storage and identity - via `lib/`)
* AWS SDK for S3 (if using Filebase)

## AI Input for refactoring
I will share with you most of my project files. Please do not react until I am done pasting. If you are asked, answer professional, in the role of a senior dev, with no social blabla, and the full files you modified.

## TODO
- shorter timeouts
- Explore would be much faster if UserStateCIDs were part of the follows (who is going to update the CID to an IPNS and when?) If I follow someone it is my obligation to cache and update that CID. Exploring users will benefit from that. But also, users without online followers will have outdated state CIDs.
- aggresive timeouts paired with a who has check might do the job already. 

- IPNS resolving can take long and might not succeed. In the Follow type, we store the lastSeenCID. How would it be to have strict and tight timeouts and fall back to these lastSeenCid fields from the follow object? 
shorter IPNS timeouts with fall back to Follow.lastSeenCid

- comment thread not shown reliably

- full screen video not working for vertical video

- tiles for media posts


