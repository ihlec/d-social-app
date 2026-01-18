# D. Social App 

A decentralized social media proof-of-concept application built with React, TypeScript, and integrating with IPFS (via Kubo).

## I have a IPFS node, what now?

-> Join a Social Network with it OR just use it for blogging. 

You can find the latest version of D. Social App here: https://ipfs.io/ipfs/bafybeiaashw34t6uogjoxvv5jrq2fdgwx7upukhfrjckp6w3dowl7kjtjm

## You want to contribute?

-> Read the [spec.md](spec.md)

## Getting Started

1.  **Install Dependencies:**
    ```bash
    npm install
    # or
    yarn install
    ```

2.  **Set up Environment (if needed):**
    * Ensure you have access to a Kubo node (if using Kubo login).
    * Configure CORS settings for the Kubo API endpoint as required by the application logic.
    * ```ipfs config --json Pubsub.Enabled true```
    * ```ipfs config --json Ipns.UsePubsub true```


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
* React Responsive Masonry (for space efficient feed rendering)
* Kubo (for decentralized storage and identity)


## TODO
- following not possible when on public gateway hosted url
- loggout on refresh bug - should stay logged in
- allow creating user aliases
- export/import of user's private key
- moderator features / filter disliked posts of followed users in the role of moderators
- scale through users - the more users cache (view) and pin (like) content, the faster the network will become.

## Remote IPFS nodes need CORS rules

For remote IPFS nodes (not localhost), configure CORS to allow the application:

```ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["*"]'```

```ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["POST", "GET", "PUT", "OPTIONS"]'```

```ipfs config --json API.HTTPHeaders.Access-Control-Allow-Headers '["Authorization", "Content-Type", "X-Requested-With"]'```

## Future Enhancements

* Allow creating user aliases
* Export/import of user's private key
* Moderator features / filter disliked posts of followed users in the role of moderators
* Scale through users - the more users cache (view) and pin (like) content, the faster the network will become
* Friend-pinning: When following a user, automatically pin their latest Profile CID to improve data availability 
