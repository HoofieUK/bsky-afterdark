import { describe, expect, jest, test, beforeEach } from '@jest/globals'
import * as externalList from '../externalList'
import { BskyAgent } from '@atproto/api'
import { Database } from '../../db'
import { Post } from '../../db/schema'
import dbClient from '../../db/dbClient'

// Mock dependencies
jest.mock('../../db/dbClient')

// Mock environment variables
process.env.SECRET_NAME = 'test-list'
process.env.SECRET_LIST = 'https://example.com/list.txt'

describe('externalList algorithm', () => {
  let mockAgent: jest.Mocked<BskyAgent>
  let mockDb: jest.Mocked<Database>
  let mockContext: any

  beforeEach(() => {
    jest.clearAllMocks()

    // Set up mock functions with any type to bypass TypeScript errors
    // @ts-ignore - Ignore TypeScript error for mock function
    dbClient.getLatestPostsForTag = jest.fn().mockResolvedValue([]) as any

    // Set up fetch mock with any type to bypass TypeScript errors
    // @ts-ignore - Ignore TypeScript error for mock function
    global.fetch = jest.fn().mockResolvedValue({
      text: () => Promise.resolve(''),
    } as any) as any

    mockAgent = {
      // Minimal mock implementation
    } as unknown as jest.Mocked<BskyAgent>

    mockDb = {
      removeTagFromOldPosts: jest.fn(),
    } as unknown as jest.Mocked<Database>

    mockContext = {
      db: mockDb,
    }

    // No need to reset mocks individually, jest.clearAllMocks() handles this
  })

  describe('handler', () => {
    test('should return feed items', async () => {
      // Arrange
      const params = {
        feed: externalList.shortname,
        limit: 50,
        cursor: undefined,
      }
      const mockPosts = [
        {
          uri: 'at://did:plc:123/app.bsky.feed.post/1',
          cid: 'cid1',
          indexedAt: Date.now(),
        },
        {
          uri: 'at://did:plc:456/app.bsky.feed.post/2',
          cid: 'cid2',
          indexedAt: Date.now(),
        },
      ]

      ;(dbClient.getLatestPostsForTag as jest.Mock<any>).mockResolvedValue(
        mockPosts,
      )

      // Act
      const result = await externalList.handler(mockContext, params)

      // Assert
      expect(dbClient.getLatestPostsForTag).toHaveBeenCalledWith({
        tag: externalList.shortname,
        limit: params.limit,
        cursor: params.cursor,
      })

      expect(result.feed).toHaveLength(2)
      expect(result.feed[0].post).toBe(mockPosts[0].uri)
      expect(result.feed[1].post).toBe(mockPosts[1].uri)
      expect(result.cursor).toBeDefined()
    })

    test('should handle empty results', async () => {
      // Arrange
      const params = {
        feed: externalList.shortname,
        limit: 50,
        cursor: undefined,
      }
      const mockPosts: any[] = []

      ;(dbClient.getLatestPostsForTag as jest.Mock<any>).mockResolvedValue(
        mockPosts,
      )

      // Act
      const result = await externalList.handler(mockContext, params)

      // Assert
      expect(dbClient.getLatestPostsForTag).toHaveBeenCalledWith({
        tag: externalList.shortname,
        limit: params.limit,
        cursor: params.cursor,
      })

      expect(result.feed).toHaveLength(0)
      expect(result.cursor).toBeUndefined()
    })
  })

  describe('manager', () => {
    let managerInstance: externalList.manager

    beforeEach(() => {
      managerInstance = new externalList.manager(mockDb, mockAgent)
      // Create a mock function that returns a Promise<void>
      const mockStartFn = jest.fn().mockImplementation(() => Promise.resolve())
      managerInstance.start = mockStartFn as unknown as () => Promise<void>
    })

    test('should initialize with correct name', () => {
      expect(managerInstance.name).toBe(externalList.shortname)
    })

    test('updateList should fetch and parse list of DIDs', async () => {
      // Arrange
      const mockResponse = `
did:plc:user1
did:plc:user2
did:plc:user3
not-a-did
      `
      // Use any type to bypass TypeScript errors
      const mockResponseObj = {
        text: () => Promise.resolve(mockResponse),
      } as any
      ;(global.fetch as jest.Mock<any>).mockResolvedValue(mockResponseObj)

      // Act
      await managerInstance.updateList()

      // Assert
      expect(global.fetch).toHaveBeenCalledWith(process.env.SECRET_LIST || '')
      expect(managerInstance.follows).toEqual([
        'did:plc:user1',
        'did:plc:user2',
        'did:plc:user3',
      ])
    })

    test('updateList should handle fetch errors', async () => {
      // Arrange
      ;(global.fetch as jest.Mock<any>).mockRejectedValue(
        new Error('Network error'),
      )

      // Act
      await managerInstance.updateList()

      // Assert
      expect(global.fetch).toHaveBeenCalledWith(process.env.SECRET_LIST || '')
      expect(managerInstance.follows).toEqual([]) // Should remain empty
    })

    test('periodicTask should update list and remove old posts', async () => {
      // Arrange
      const mockUpdateList = jest.spyOn(managerInstance, 'updateList')
      mockUpdateList.mockImplementation(async () => {})

      // Act
      await managerInstance.periodicTask()

      // Assert
      expect(mockUpdateList).toHaveBeenCalled()
      expect(mockDb.removeTagFromOldPosts).toHaveBeenCalledWith(
        externalList.shortname,
        expect.any(Number),
      )
    })

    test('filter_post should reject reply posts', async () => {
      // Arrange
      const replyPost: Post = {
        _id: null,
        uri: 'at://did:plc:valid/app.bsky.feed.post/1',
        cid: 'cid1',
        author: 'did:plc:valid',
        text: 'Test reply',
        indexedAt: Date.now(),
        replyRoot: 'at://did:plc:other/app.bsky.feed.post/1',
        replyParent: 'at://did:plc:other/app.bsky.feed.post/1',
        algoTags: null,
      }

      // Act
      const result = await managerInstance.filter_post(replyPost)

      // Assert
      expect(result).toBe(false)
    })

    test('filter_post should accept posts from authors in follows list', async () => {
      // Arrange
      const authorInListPost: Post = {
        _id: null,
        uri: 'at://did:plc:user1/app.bsky.feed.post/1',
        cid: 'cid1',
        author: 'did:plc:user1',
        text: 'Test post',
        indexedAt: Date.now(),
        replyRoot: null,
        replyParent: null,
        algoTags: null,
      }

      // Set up follows list
      managerInstance.follows = ['did:plc:user1', 'did:plc:user2']

      // Act
      const result = await managerInstance.filter_post(authorInListPost)

      // Assert
      expect(result).toBe(true)
    })

    test('filter_post should reject posts from authors not in follows list', async () => {
      // Arrange
      const authorNotInListPost: Post = {
        _id: null,
        uri: 'at://did:plc:other/app.bsky.feed.post/1',
        cid: 'cid1',
        author: 'did:plc:other',
        text: 'Test post',
        indexedAt: Date.now(),
        replyRoot: null,
        replyParent: null,
        algoTags: null,
      }

      // Set up follows list
      managerInstance.follows = ['did:plc:user1', 'did:plc:user2']

      // Act
      const result = await managerInstance.filter_post(authorNotInListPost)

      // Assert
      expect(result).toBe(false)
    })

    test('filter_post should update list if follows is empty', async () => {
      // Arrange
      const post: Post = {
        _id: null,
        uri: 'at://did:plc:user1/app.bsky.feed.post/1',
        cid: 'cid1',
        author: 'did:plc:user1',
        text: 'Test post',
        indexedAt: Date.now(),
        replyRoot: null,
        replyParent: null,
        algoTags: null,
      }

      // Ensure follows is empty
      managerInstance.follows = []

      // Mock updateList
      const mockUpdateList = jest.spyOn(managerInstance, 'updateList')
      mockUpdateList.mockImplementation(async () => {
        managerInstance.follows = ['did:plc:user1']
      })

      // Act
      const result = await managerInstance.filter_post(post)

      // Assert
      expect(mockUpdateList).toHaveBeenCalled()
      expect(result).toBe(true)
    })

    test('filter_post should call start if agent is null', async () => {
      // Arrange
      const post: Post = {
        _id: null,
        uri: 'at://did:plc:user1/app.bsky.feed.post/1',
        cid: 'cid1',
        author: 'did:plc:user1',
        text: 'Test post',
        indexedAt: Date.now(),
        replyRoot: null,
        replyParent: null,
        algoTags: null,
      }

      // Set up follows list
      managerInstance.follows = ['did:plc:user1']

      // Use 'as any' to bypass type checking for this test
      managerInstance.agent = null as any

      // Act
      await managerInstance.filter_post(post)

      // Assert
      expect(managerInstance.start).toHaveBeenCalled()
    })
  })
})
