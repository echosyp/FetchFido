#!/usr/bin/env python3
#THIS SCRIPT REQUIRES COMMANDLINE ARGUMENTS FOR IP:PORT

import socket
import time
import sys

def send_gps_data(host='192.168.120.13', port=9998):
    """Send GPS coordinates to the FetchFido UDP server"""
    
    # Test coordinates (San Francisco area).
    # Deliberately far from the device's real reporting area so test points are
    # never mistaken for genuine data.
    test_coordinates = [
        "37.7955,-122.3937",  # Ferry Building
        '{"lat": 37.8199, "lon": -122.4783}',  # Golden Gate Bridge
        "37.8024 -122.4058",  # Coit Tower
        "37.7763,-122.4327",  # Alamo Square
    ]
    
    print("=" * 64)
    print("REMINDER: turn the VPN OFF and confirm port forwarding is ON.")
    print("UDP fails silently -- if either is wrong, this script will still")
    print("report success while nothing reaches the server.")
    print("=" * 64)

    print(f"Sending GPS coordinates to {host}:{port}")
    
    try:
        # Create UDP socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        
        for i, coords in enumerate(test_coordinates, 1):
            print(f"Sending coordinate {i}: {coords}")
            
            # Send the coordinate data
            sock.sendto(coords.encode('utf-8'), (host, port))
            
            # Wait a bit between sends
            time.sleep(2)
            
        print("All coordinates sent successfully!")
        print("Check the web interface at http://192.168.120.13:8080 to see if markers appear on the map.")
        
    except Exception as e:
        print(f"Error sending GPS data: {e}")
        
    finally:
        sock.close()

if __name__ == "__main__":
    # Allow custom host/port
    host = sys.argv[1] if len(sys.argv) > 1 else '192.168.120.13'
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 9998
    
    send_gps_data(host, port)