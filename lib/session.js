// 会话层：一条会话 = 一张卡 + 消息数组；每条消息可有多个候选（swipe）。
import { join } from 'node:path'
import { newId, paths, readJson, writeJson, listFiles, removeFile } from './store.js'

function chatFile(chatId, root) {
  return join(paths(root).chats, `${chatId}.json`)
}

export async function listChats(root) {
  const dir = paths(root).chats
  const names = await listFiles(dir, '.json')
  const chats = []
  for (const name of names) {
    const chat = await readJson(join(dir, name), null)
    if (!chat) continue
    chats.push({
      id: chat.id,
      title: chat.title,
      cardId: chat.cardId,
      messageCount: Array.isArray(chat.messages) ? chat.messages.length : 0,
      updatedAt: chat.updatedAt,
      createdAt: chat.createdAt
    })
  }
  return chats.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
}

export async function loadChat(chatId, root) {
  return readJson(chatFile(chatId, root), null)
}

export async function saveChat(chat, root) {
  chat.updatedAt = new Date().toISOString()
  await writeJson(chatFile(chat.id, root), chat)
  return chat
}

export async function createChat({ cardId, title }, root) {
  const now = new Date().toISOString()
  const chat = {
    id: newId('chat'),
    cardId,
    title: title || '新对话',
    createdAt: now,
    updatedAt: now,
    messages: []
  }
  return saveChat(chat, root)
}

export async function deleteChat(chatId, root) {
  await removeFile(chatFile(chatId, root))
}

function makeMessage(role, content) {
  return {
    id: newId('msg'),
    role,
    content: String(content || ''),
    variants: [String(content || '')],
    activeVariant: 0,
    createdAt: new Date().toISOString()
  }
}

export async function appendMessage(chat, { role, content }) {
  const message = makeMessage(role, content)
  chat.messages = Array.isArray(chat.messages) ? chat.messages : []
  chat.messages.push(message)
  return message
}

// 重 roll / swipe：给某条消息追加候选，或切换当前候选。
export function addVariant(chat, messageId, content) {
  const message = (chat.messages || []).find((m) => m.id === messageId)
  if (!message) throw new Error(`message ${messageId} not found`)
  message.variants = Array.isArray(message.variants) ? message.variants : [message.content || '']
  message.variants.push(String(content || ''))
  message.activeVariant = message.variants.length - 1
  message.content = message.variants[message.activeVariant]
  return message
}

export function selectVariant(chat, messageId, index) {
  const message = (chat.messages || []).find((m) => m.id === messageId)
  if (!message) throw new Error(`message ${messageId} not found`)
  const variants = Array.isArray(message.variants) && message.variants.length > 0 ? message.variants : [message.content || '']
  if (index < 0 || index >= variants.length) throw new Error(`variant index ${index} out of range`)
  message.activeVariant = index
  message.content = variants[index]
  return message
}

export function editMessage(chat, messageId, content) {
  const message = (chat.messages || []).find((m) => m.id === messageId)
  if (!message) throw new Error(`message ${messageId} not found`)
  message.content = String(content || '')
  message.variants = [message.content]
  message.activeVariant = 0
  return message
}

// 给模型看的消息列表：过滤掉系统消息，保留角色交替。
export function toModelMessages(chat, limit = 40) {
  const messages = Array.isArray(chat.messages) ? chat.messages : []
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-limit)
    .map((m) => ({ role: m.role, content: m.content }))
}
