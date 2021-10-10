import { createMatch, getFilterPlayerView } from "boardgame.io/internal";
import { Master } from "boardgame.io/master";
import type { Game } from "boardgame.io";
import { P2PDB } from "./db";
import type { Client, ClientAction } from "./types";

/**
 * Peer-to-peer host class, which runs a local `Master` instance
 * and sends authoritative state updates to all connected players.
 */
export class P2PHost {
  private clients: Map<Client, Client> = new Map();
  private matchID: string;
  private master: Master;
  private db: P2PDB;

  constructor({
    game,
    numPlayers = 2,
    matchID,
  }: {
    game: Game;
    numPlayers: number;
    matchID: string;
  }) {
    this.matchID = matchID;

    if (!game.name || game.name === "default") {
      console.error(
        'Using "default" as your game name.\n' +
          "Please set the `name` property of your game definition " +
          "to a unique string to help avoid peer ID conflicts."
      );
    }

    const match = createMatch({
      game,
      numPlayers,
      unlisted: false,
      setupData: undefined,
    });
    if ("setupDataError" in match) {
      throw new Error("setupData Error: " + match.setupDataError);
    }

    this.db = new P2PDB();
    this.db.createMatch(this.matchID, match);

    const filterPlayerView = getFilterPlayerView(game);

    this.master = new Master(game, this.db, {
      send: ({ playerID, ...data }) => {
        const playerView = filterPlayerView(playerID, data);
        for (const [client] of this.clients) {
          if (client.metadata.playerID === playerID) client.send(playerView);
        }
      },
      sendAll: (data) => {
        for (const [client] of this.clients) {
          const playerView = filterPlayerView(client.metadata.playerID, data);
          client.send(playerView);
        }
      },
    });
  }

  registerClient(client: Client): void {
    const isAuthenticated: boolean = this.authenticateClient(client);
    // If the client failed to authenticate, don’t register it.
    if (!isAuthenticated) return;
    const { playerID, credentials } = client.metadata;
    this.clients.set(client, client);
    this.master.onConnectionChange(this.matchID, playerID, credentials, true);
  }

  /**
   * Store a player’s credentials on initial connection and authenticate them subsequently.
   * @param client Client to authenticate.
   * @returns `true` if the client was successfully authenticated, `false` if it wasn’t.
   */
  private authenticateClient(client: Client): boolean {
    const { playerID, credentials } = client.metadata;
    const { metadata } = this.db.fetch(this.matchID);

    // Spectators provide null/undefined playerIDs and don’t need authenticating.
    if (
      playerID === null ||
      playerID === undefined ||
      !(+playerID in metadata.players)
    ) {
      return true;
    }

    const existingCredentials = metadata.players[+playerID].credentials;

    // If no credentials exist yet for this player, store those
    // provided by the connecting client and authenticate.
    if (!existingCredentials && credentials) {
      this.db.setMetadata(this.matchID, {
        ...metadata,
        players: {
          ...metadata.players,
          [+playerID]: { ...metadata.players[+playerID], credentials },
        },
      });
      return true;
    }

    // If credentials are neither provided nor stored, authenticate.
    if (!existingCredentials && !credentials) return true;

    // If credentials match, authenticate.
    return credentials === existingCredentials;
  }

  unregisterClient(client: Client): void {
    const { credentials, playerID } = client.metadata;
    this.clients.delete(client);
    this.master.onConnectionChange(this.matchID, playerID, credentials, false);
  }

  processAction(data: ClientAction): void {
    switch (data.type) {
      case "update":
        this.master.onUpdate(...data.args);
        break;
      case "chat":
        this.master.onChatMessage(...data.args);
        break;
      case "sync":
        this.master.onSync(...data.args);
        break;
    }
  }
}
