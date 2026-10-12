const state = {
  user: null,
  config: null,
  directory: [],
  direction: null,
  directionLocked: false,
  dateKey: null,
  query: '',
  rides: [],
  notifications: [],
  tab: 'hosted',
  status: 'idle',
  error: '',
};

const listeners = new Set();

export const store = {
  get() {
    return state;
  },
  set(partial) {
    Object.assign(state, partial);
    listeners.forEach((listener) => listener(state));
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function patchRide(rideId, partial) {
  store.set({
    rides: state.rides.map((ride) => (ride.ride_id === rideId ? { ...ride, ...partial } : ride)),
  });
}
