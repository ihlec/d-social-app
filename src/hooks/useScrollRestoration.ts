// fileName: src/hooks/useScrollRestoration.ts
import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';

export const useScrollRestoration = (
    // FIX: Allow null in the RefObject type to match useRef(null)
    containerRef: React.RefObject<HTMLDivElement | null>,
    isLoadingMore: boolean,
    dataDependency: any[] 
) => {
    const [isScrollLocked, setIsScrollLocked] = useState(false);
    const scrollAnchorRef = useRef<{ id: string | null; top: number }>({ id: null, top: 0 });
    const wasLoadingMore = useRef(false);
    const isRestoringScroll = useRef(false);

    // --- 1. Lock/Unlock Scroll Effect ---
    useEffect(() => {
        if (isScrollLocked) {
            document.body.style.overflowY = 'hidden';
            const unlockTimeout = setTimeout(() => {
                // Revert to CSS defined value (which is 'scroll') to avoid layout shift
                document.body.style.removeProperty('overflow-y');
                setIsScrollLocked(false);
            }, 200); 
            return () => clearTimeout(unlockTimeout);
        } else {
            document.body.style.removeProperty('overflow-y');
        }
    }, [isScrollLocked]);

    // --- 2. Capture Anchor ---
    const captureScrollAnchor = useCallback(() => {
        if (containerRef.current) {
            const posts = containerRef.current.querySelectorAll('.post[data-post-id]');
            let bestCandidate: { id: string | null, top: number } = { id: null, top: Infinity };
            
            posts.forEach(postElement => {
                const rect = postElement.getBoundingClientRect();
                if (rect.bottom > -50 && rect.top < bestCandidate.top) {
                    bestCandidate = { id: postElement.getAttribute('data-post-id'), top: rect.top };
                }
            });

            if (bestCandidate.id) {
                scrollAnchorRef.current = bestCandidate;
                console.log(`[useScrollRestoration] Anchor Set: ${bestCandidate.id} @ ${bestCandidate.top}`);
            } else {
                scrollAnchorRef.current = { id: null, top: 0 };
            }
        }
        
        wasLoadingMore.current = true;
        setIsScrollLocked(true); 
    }, [containerRef]);

    // --- 3. Restore Scroll ---
    useLayoutEffect(() => {
        if (wasLoadingMore.current && !isLoadingMore && scrollAnchorRef.current.id && !isRestoringScroll.current) {
            const anchorId = scrollAnchorRef.current.id;
            const storedTop = scrollAnchorRef.current.top;

            const rafId = requestAnimationFrame(() => {
                const anchorElement = containerRef.current?.querySelector(`[data-post-id="${anchorId}"]`);

                if (anchorElement) {
                    const newRect = anchorElement.getBoundingClientRect();
                    const scrollOffset = newRect.top - storedTop;

                    if (Math.abs(scrollOffset) > 1) {
                        isRestoringScroll.current = true;
                        window.scrollBy({ top: scrollOffset, left: 0, behavior: 'instant' });
                        requestAnimationFrame(() => { isRestoringScroll.current = false; });
                    }
                }
            });

            wasLoadingMore.current = false;
            scrollAnchorRef.current = { id: null, top: 0 };

            return () => cancelAnimationFrame(rafId);
        } else if (!isLoadingMore && wasLoadingMore.current) {
             wasLoadingMore.current = false;
        }
    }, [isLoadingMore, ...dataDependency]);

    return { 
        captureScrollAnchor, 
        isScrollLocked 
    };
};