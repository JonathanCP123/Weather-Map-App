// Google Places lookups.

import type { PlaceInfo } from '../types';

/** Name, address, Maps link and wheelchair access for a Google place, or null on failure. */
export const getPlaceDetails = async (
  placesLib: google.maps.PlacesLibrary | null,
  placesService: google.maps.places.PlacesService | null,
  placeId: string
): Promise<PlaceInfo | null> => {
  try {
    if (!placesLib) return null;
    const place = new placesLib.Place({ id: placeId });

    await place.fetchFields({
      fields: ['displayName', 'formattedAddress', 'accessibilityOptions', 'googleMapsURI'],
    });

    // Extract Name
    let name = "Selected Location";
    const dn = place.displayName as any;
    if (dn) {
      name = typeof dn === 'string' ? dn : dn.text || "Selected Location";
    }

    let isAccessible: boolean | null = null;
    if (
      place.accessibilityOptions &&
      place.accessibilityOptions.hasWheelchairAccessibleEntrance !== undefined &&
      place.accessibilityOptions.hasWheelchairAccessibleEntrance !== null
    ) {
      isAccessible = place.accessibilityOptions.hasWheelchairAccessibleEntrance;
    }

    return {
      id: placeId,
      name: name,
      address: place.formattedAddress || '',
      mapsUri: place.googleMapsURI || `https://www.google.com/maps/place/?q=place_id:${placeId}`,
      accessibility: isAccessible,
    };
  } catch (err) {
    console.warn('Place fetchFields failed, using PlacesService fallback', err);
    return new Promise((resolve) => {
      if (!placesService) return resolve(null);
      placesService.getDetails(
        { placeId: placeId, fields: ['name', 'formatted_address', 'url'] },
        (place, status) => {
          if (status === google.maps.places.PlacesServiceStatus.OK && place) {
            resolve({
              id: placeId,
              name: place.name || 'Selected Location',
              address: place.formatted_address || '',
              mapsUri: place.url || `https://www.google.com/maps/place/?q=place_id:${placeId}`,
              accessibility: null,
            });
          } else {
            resolve(null);
          }
        }
      );
    });
  }
};

/** Builds a PlaceInfo for a spot on the map from a reverse-geocode result. */
export const placeInfoFromGeocode = (
  latLng: google.maps.LatLng,
  results: google.maps.GeocoderResult[] | null,
  status: google.maps.GeocoderStatus | string
): PlaceInfo => {
  const placeInfo: PlaceInfo = {
    name: 'Selected Location',
    address: '',
    mapsUri: `https://www.google.com/maps/search/?api=1&query=${latLng.lat()},${latLng.lng()}`,
    accessibility: null,
  };

  if (status === 'OK' && results && results[0]) {
    const topResult = results[0];
    placeInfo.address = topResult.formatted_address;

    const street = topResult.address_components.find((c) => c.types.includes('route'));
    const area = topResult.address_components.find(
      (c) => c.types.includes('sublocality') || c.types.includes('locality')
    );

    if (street) {
      placeInfo.name = street.long_name;
    } else if (area) {
      placeInfo.name = area.long_name;
    } else {
      placeInfo.name = topResult.address_components[0].long_name;
    }
  }

  return placeInfo;
};
