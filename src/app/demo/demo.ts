import { Component, ElementRef, effect, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { MqttClient } from 'mqtt';
import * as mqttLib from 'mqtt';

// Works whichever way the installed mqtt bundle exposes `connect`.
const mqtt: any = (mqttLib as any).default ?? mqttLib;

interface Msg {
  id: string;
  cid: string;
  type: 'chat' | 'sys';
  name: string;
  text: string;
  ts: number;
}

// Free public MQTT-over-WebSocket broker. Swap for 'wss://broker.hivemq.com:8884/mqtt' if needed.
const BROKER = 'wss://broker.emqx.io:8084/mqtt';
// Make this unique to you so your rooms don't collide with other apps on the public broker.
const NAMESPACE = 'ng-open-chat-v1';

@Component({
  selector: 'app-demo',
  imports: [FormsModule, DatePipe],
  templateUrl: './demo.html',
  styleUrl: './demo.css',
})
export class Demo {
  name = '';
  room = 'lobby';
  draft = '';

  joined = signal(false);
  status = signal<'connecting' | 'online' | 'offline'>('connecting');
  messages = signal<Msg[]>([]);
  toast = signal('');

  private client?: MqttClient;
  private topic = '';
  private announced = false;
  private readonly cid = crypto.randomUUID();
  private list = viewChild<ElementRef<HTMLElement>>('list');

  constructor() {
    try {
      this.name = localStorage.getItem('chat-name') ?? '';
      this.room = localStorage.getItem('chat-room') ?? 'lobby';
    } catch {
      /* storage unavailable */
    }
    // Invite links look like  https://.../?room=friends  and pre-fill the room.
    const r = new URLSearchParams(location.search).get('room');
    if (r) this.room = r;
    effect(() => {
      this.messages();
      setTimeout(() => {
        const el = this.list()?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
  }

  join() {
    const name = this.name.trim().slice(0, 24);
    if (!name) return;
    this.name = name;
    const room = this.room.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30) || 'lobby';
    this.room = room;
    try {
      localStorage.setItem('chat-name', name);
      localStorage.setItem('chat-room', room);
    } catch {
      /* storage unavailable */
    }
    this.topic = `${NAMESPACE}/${room}`;
    this.joined.set(true);
    this.status.set('connecting');

    const client: MqttClient = mqtt.connect(BROKER, {
      clientId: 'ngchat_' + this.cid.slice(0, 12),
      reconnectPeriod: 2000,
      will: {
        topic: this.topic,
        payload: JSON.stringify(this.make('sys', `${name} left`)),
        qos: 0,
        retain: false,
      },
    });
    this.client = client;

    client.on('connect', () => {
      client.subscribe(this.topic, { qos: 0 });
      this.status.set('online');
      if (!this.announced) {
        this.announced = true;
        this.publish(this.make('sys', `${name} joined`));
      }
    });
    client.on('reconnect', () => this.status.set('connecting'));
    client.on('offline', () => this.status.set('offline'));
    client.on('close', () => this.status.set('offline'));
    client.on('message', (_topic: string, payload: Uint8Array) => {
      try {
        const m = JSON.parse(new TextDecoder().decode(payload)) as Msg;
        if (!m?.id || typeof m.text !== 'string') return;
        this.messages.update((list) =>
          list.some((x) => x.id === m.id) ? list : [...list, m].slice(-300),
        );
      } catch {
        /* ignore malformed packets */
      }
    });
  }

  send() {
    const text = this.draft.trim().slice(0, 1000);
    if (!text || this.status() !== 'online') return;
    this.publish(this.make('chat', text));
    this.draft = '';
  }

  leave() {
    this.publish(this.make('sys', `${this.name} left`));
    this.client?.end();
    this.client = undefined;
    this.announced = false;
    this.messages.set([]);
    this.joined.set(false);
  }

  async invite() {
    const url = `${location.origin}${location.pathname}?room=${this.room}`;
    const text = `Join my chat room "${this.room}"`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Open chat', text, url });
      } else {
        await navigator.clipboard.writeText(url);
        this.toast.set('Invite link copied');
        setTimeout(() => this.toast.set(''), 2000);
      }
    } catch {
      /* user cancelled sharing */
    }
  }

  // Show the sender's name only on the first bubble of a run from the same person.
  showName(i: number) {
    const list = this.messages();
    const m = list[i];
    const prev = list[i - 1];
    return !this.isMine(m) && (!prev || prev.type === 'sys' || prev.cid !== m.cid);
  }

  isMine(m: Msg) {
    return m.cid === this.cid;
  }

  // Stable colour per person, derived from their name.
  hue(name: string) {
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
    return h;
  }

  private make(type: Msg['type'], text: string): Msg {
    return { id: crypto.randomUUID(), cid: this.cid, type, name: this.name, text, ts: Date.now() };
  }

  private publish(m: Msg) {
    this.client?.publish(this.topic, JSON.stringify(m), { qos: 0 });
  }
}
