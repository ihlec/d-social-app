# D. Social App (Reconstructed)

A decentralized social media proof-of-concept application built with React, TypeScript, and potentially integrating with IPFS (via Kubo or Filebase).

This project is a reconstruction based on distributed application files.

## Project Structure

* `public/`: Static assets and the main HTML file.
* `src/`: Contains all the React/TypeScript source code.
    * `components/`: Reusable UI components (Auth, Common, Feed, Layout, Profile).
    * `contexts/`: React Context for global state management (`AppStateContext`).
    * `hooks/`: Custom React Hooks (`useAppState`, `useCooldown`, etc.).
    * `lib/`: Utility functions (IPFS/Filebase interactions, media handling, general utils).
    * `pages/`: Top-level page components (`HomePage`, `ProfilePage`, `PostPage`).
    * `router/`: Routing configuration using `react-router-dom`.
    * `types/`: TypeScript type definitions.
    * `App.tsx`: Main application component setting up context and router.
    * `main.tsx`: Entry point for the React application.
    * `index.css`: Global styles (copied from original bundle).

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
    # or
    yarn dev
    ```
    This will start the Vite development server, typically at `http://localhost:5173`.

4.  **Build for Production:**
    ```bash
    npm run build
    # or
    yarn build
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

## Notes

* This reconstruction is based on inference from bundled code. Original variable names, comments, and exact logic might differ.
* The IPFS and Filebase interaction logic in `src/lib/` contains placeholders and requires careful implementation and testing against the actual APIs.
* AWS S3 client (`@aws-sdk/client-s3`) needs proper configuration (credentials, region) likely handled within the login flow in `useAppState.ts` for Filebase.

## AI Debug
I will share with you most of my project files. Please do not react until I am done pasting. If you are asked, answer professional, in the role of a senior dev, with no social blabla, and the full files you modified.

## TODO

- expose shared pages to not-logged-in users
- comments parents and post children
- replying to test shows IPNS instead of label
- keep like red - directly after clicking not just on refresh 

