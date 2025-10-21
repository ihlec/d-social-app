import React, { useState, ReactNode } from 'react';

interface TooltipProps {
  text: ReactNode; // For JSX in tooltips
  children: ReactNode;
}

export const Tooltip: React.FC<TooltipProps> = ({ text, children }) => {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <span
      className="tooltip-wrapper"
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
    >
      {children}
      {isVisible && (
        <div className="tooltip-popup">
          {text}
        </div>
      )}
    </span>
  );
};