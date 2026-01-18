# Performance Optimization Plan

Based on log analysis, here are the key bottlenecks and optimization strategies:

## Issues Identified

1. **Excessive Feed Recalculations** (53 recalculations)
   - Feed recalculates on every single post addition
   - No debouncing/throttling
   - Each recalculation triggers expensive filtering operations

2. **504 Gateway Timeouts** (Many failures)
   - Multiple requests timing out at ipfs.io
   - Content not cached, requiring DHT lookups
   - Sequential failures blocking progress

3. **Inefficient User State Fetching**
   - Not using `allUserStatesMap` cache effectively
   - Fetching state chunks when full state is already cached
   - Populating map from `lastSeenCid` happens but isn't used

4. **Sequential Processing**
   - While using `Promise.allSettled`, failures cause delays
   - No retry logic with backoff
   - Failed CIDs retried immediately

5. **Small Batch Sizes**
   - PAGE_SIZE = 1 causes many recalculations
   - Each post addition triggers full feed recalculation

## Optimization Strategies

### 1. Debounce Feed Recalculations
**Priority: HIGH**
- Add debouncing (200-300ms) to feed recalculation
- Only recalculate when batch of posts is added, not individual posts
- Use `useMemo` with proper dependencies

### 2. Use allUserStatesMap in fetchStateAndPosts
**Priority: HIGH**
- Check `allUserStatesMap` before fetching state chunks
- If user state exists, extract postCIDs directly from map
- Only fetch chunks if state not in map

### 3. Better 504 Error Handling
**Priority: MEDIUM**
- Mark failed CIDs with cooldown (don't retry immediately)
- Skip failed CIDs in batch processing
- Use exponential backoff for retries

### 4. Batch User State Population
**Priority: MEDIUM**
- Populate `allUserStatesMap` in smaller batches (2-3 at a time)
- Don't block initial feed load
- Process in background with delays between batches

### 5. Increase Initial Batch Size
**Priority: LOW**
- Increase PAGE_SIZE from 1 to 3-5 for initial load
- Reduces number of recalculations
- Still maintain pagination for "load more"

### 6. Parallelize Follow Processing
**Priority: MEDIUM**
- Process follows in parallel batches (3-4 at a time)
- Don't wait for all to complete before showing feed
- Use staggered delays to avoid gateway overload

### 7. Cache Failed CIDs
**Priority: LOW**
- Track failed CIDs in a Set
- Skip retrying failed CIDs for a period (5-10 minutes)
- Clear cache on manual refresh

## Implementation Order

1. **Phase 1 (Immediate Impact)**:
   - Debounce feed recalculations
   - Use allUserStatesMap in fetchStateAndPosts
   - Better 504 error handling

2. **Phase 2 (Medium Impact)**:
   - Batch user state population
   - Parallelize follow processing
   - Increase initial batch size

3. **Phase 3 (Polish)**:
   - Cache failed CIDs
   - Add retry backoff logic
   - Optimize useMemo dependencies
