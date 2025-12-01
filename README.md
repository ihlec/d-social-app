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
* React Virtuoso (for efficient list rendering)
* Kubo (for decentralized storage and identity)
* AWS SDK for S3 (if using Filebase)

## AI Input for refactoring
I will share with you most of my project files. Please do not react until I am done pasting. If you are asked, answer professional, in the role of a senior dev, with no social blabla, no sugar-coating and with the full files you modified.

## TODO

- make one helia branch client with pubsub (currenlty NAT traversal issues in the browser)
- myfeed is only properly refreshed when running explore
- refresh button does not discover new recent posts
- fix explore feed to show new content only
- fix explore feed to explore multiple levels
- introduce settings sidebar on the right
- setting to pick gateway
- moderator features
- scale through users - the more users cache (view) and pin (like) content, the faster the network will become.

## Remote IPFS nodes need cors rules

ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["*"]'
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["POST", "GET", "PUT", "OPTIONS"]'
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Headers '["Authorization", "Content-Type", "X-Requested-With"]'
