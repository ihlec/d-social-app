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
- use only My Feed and Explore + profile page
- Make UserName hover over media post
- only show comments on full width single column on pop-out
- comment thread not shown reliably
- fix comment icon in pop-out and on comment page
- show comments on post page
- login IPNS Label Tooltip missing
- fix user key span to show more of the actual ipns key
- public view container for post not centerd and no comments possible. For logged in users comment button should lead to reply to page
- double use of edit bio button edit-follow-button



