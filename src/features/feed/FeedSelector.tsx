// src/features/feed/FeedSelector.tsx
import React from 'react';

// --- FIX: Remove 'myPosts' type ---
type FeedType = 'myFeed' | 'explore';
// --- End Fix ---

interface FeedSelectorProps {
  selectedFeed: FeedType;
  onSelectFeed: (feed: FeedType) => void;
}

const FeedSelector: React.FC<FeedSelectorProps> = ({ selectedFeed, onSelectFeed }) => {
  return (
    <div className="feed-selector">
      {/* --- FIX: Remove 'myPosts' button --- */}
      {/*
      <button
        className={selectedFeed === 'myPosts' ? 'active' : ''}
        onClick={() => onSelectFeed('myPosts')}
      >
        My Posts
      </button>
      */}
      {/* --- End Fix --- */}
      <button
        className={selectedFeed === 'myFeed' ? 'active' : ''}
        onClick={() => onSelectFeed('myFeed')}
      >
        My Feed
      </button>
      <button
        className={selectedFeed === 'explore' ? 'active' : ''}
        onClick={() => onSelectFeed('explore')}
      >
        Explore
      </button>
    </div>
  );
};

export default FeedSelector;