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
- smart incremental fetching. First Chunk of each user first. Then check if page is filled. If not, load more. Then load further chunks while scrolling. If manual refresh is clicked, start with first chunks again (resolved via IPNS-key)

- myfeed is only properly refreshed when running explore
- refresh button does not discover new recent posts

- fix explore feed to show new content only
- fix explore feed to explore multiple levels

- introduce settings sidebar on the right
- setting to pick presenceServer
- setting to pick gateway

- show the copied post also on Other Users Online


- double use of edit bio button edit-follow-button (rename)

## Local test users

Cornelius
Ben
Tom
Failicitas

## Remote IPFS nodes need cors rules

{
  "API": {
    "HTTPHeaders": {
      "Access-Control-Allow-Origin": [
        "*", 
      ],
      "Access-Control-Allow-Methods": [
        "*"
      ],
      "Access-Control-Allow-Headers": [
        "Authorization", 
        "Content-Type" 
      ]
      "Access-Control-Allow-Credentials": ["true"]
    }
  },
  "Gateway": {
     // It's also good practice to configure Gateway CORS
    "HTTPHeaders": {
       "Access-Control-Allow-Origin": ["*"],
       "Access-Control-Allow-Methods": ["*"],
       "Access-Control-Allow-Headers": ["Content-Type"]
    }
  }
}


## Algo sketching

It takes too long until the user sees the first posts in such feeds. My proposal is to only load posts incrementally and in sync with the user scrolling through the feed. Initially I would like to load only one chunk per userState. Then I want to show the discovered posts in the current feed. Then I want to check if there are enough posts to fill the entire page. If not the next chunk of each userState is loaded. Once the page is populated entierly with posts, the user can scroll. If he scrolls and the there are not enough posts to fill the page anymore, the next userState chunk of each user is loaded, and so on.

 load one state chunk ahead. So we do not see unloaded media when scrolling fast