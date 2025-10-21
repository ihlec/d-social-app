import React from 'react';

type FeedType = 'myPosts' | 'myFeed' | 'explore';

interface FeedSelectorProps {
  selectedFeed: FeedType;
  onSelectFeed: (feed: FeedType) => void;
}

const FeedSelector: React.FC<FeedSelectorProps> = ({ selectedFeed, onSelectFeed }) => {
  return (
    <div className="feed-selector">
      <button
        className={selectedFeed === 'myPosts' ? 'active' : ''}
        onClick={() => onSelectFeed('myPosts')}
      >
        My Posts
      </button>
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