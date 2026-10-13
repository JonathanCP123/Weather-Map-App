// Google Directions helpers.

/** Turns a DirectionsService status code (e.g. "ZERO_RESULTS") into a message for the user. */
export const directionsErrorMessage = (status: google.maps.DirectionsStatus | string): string => {
  switch (status) {
    case 'NOT_FOUND':
      return "Couldn't find the origin or destination. Check the spelling and try again.";
    case 'ZERO_RESULTS':
      return 'No route found between those places. Try a different travel mode.';
    case 'MAX_ROUTE_LENGTH_EXCEEDED':
      return 'That route is too long to calculate.';
    case 'OVER_QUERY_LIMIT':
      return 'Too many route requests. Wait a moment and try again.';
    default:
      return 'Could not calculate the route. Try again.';
  }
};
